import express, { Request, Response, NextFunction } from "express"
import http from "http"
import os from "os"
import cors from "cors"
import helmet from "helmet"
import compression from "compression"
import rateLimit from "express-rate-limit"
import { randomUUID } from "crypto"
import { pathToFileURL } from "url"
import { Bonjour, type Service } from "bonjour-service"
import packageJson from "./package.json" with { type: "json" }
import { startStaleSessionCleanup, stopStaleSessionCleanup } from "./jobs/sessionCleanup.js"
import { logger } from "./utils/logger.js"

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET env var is not set")
if (process.env.JWT_SECRET.length < 32)
  throw new Error(
    "JWT_SECRET is too weak — use at least 32 characters of high-entropy randomness",
  )
if (!process.env.ALLOWED_ORIGINS)
  throw new Error(
    "ALLOWED_ORIGINS env var is not set — set it to a comma-separated list of allowed origins (e.g. https://yourapp.com)",
  )

import { testDatabaseConnection, pool } from "./config/database.js"
import { createWsServer, closeWsServer } from "./ws/wsServer.js"
import { registerRoutes } from "./routes.js"
import { errorHandler } from "./middleware/errorHandler.js"
import { authenticateToken } from "./middleware/auth.js"

// Declared here rather than in express.d.ts to keep it co-located with the
// only middleware that sets it. If other files need req.reqId, move it to
// src/types/express.d.ts alongside req.user.
declare global {
  namespace Express {
    interface Request {
      reqId?: string
    }
  }
}

export const app = express()
const PORT = process.env.PORT || 5000

// Behind a reverse proxy, req.ip must come from X-Forwarded-For or
// express-rate-limit keys every client into one shared bucket. Exposed
// directly (the `docker run -p 5000:5000` path in the README) the header is
// entirely caller-supplied, so trusting a hop there lets an attacker rotate
// X-Forwarded-For and reset the auth limiter's bucket on every request.
// Default to 0 — req.ip is then the unspoofable socket address — and let a
// proxied deployment opt in with TRUST_PROXY_HOPS=1.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 0))

// This is a JSON API with no HTML views (public/ has no static assets today),
// so lock CSP down to "load nothing" rather than the browser-page-oriented
// defaults helmet ships with.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"] },
    },
  }),
)

const allowedOrigins = process.env.ALLOWED_ORIGINS.split(",").map((o) =>
  o.trim(),
)
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
)

// Every response here is JSON, which gzips ~10x. Defaults are right for this
// box: the 1kb threshold skips the small writes that dominate the request
// count, and the built-in filter leaves already-compressed types alone, so
// progress-photo bytes don't get run through zlib for nothing.
app.use(compression())

app.use((req: Request, _res: Response, next: NextFunction) => {
  req.reqId = randomUUID()
  next()
})

app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.path !== "/healthz") {
    logger.info(`[${req.method}] ${req.path}`, {
      auth: req.headers.authorization ? "present" : "missing",
      reqId: req.reqId,
    })
  }
  next()
})

// Loopback/private-range check for RATE_LIMIT_BYPASS_LOCAL_IPS — trust proxy
// is set above, so req.ip is already the real client IP, not the proxy's.
const isLocalIp = (ip: string) =>
  /^(127\.|10\.|192\.168\.|::1$|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.)/.test(
    ip,
  ) ||
  /^(172\.(1[6-9]|2\d|3[01])\.|::ffff:172\.(1[6-9]|2\d|3[01])\.)/.test(ip)

const bypassLocalIps = process.env.RATE_LIMIT_BYPASS_LOCAL_IPS === "true"

// Strict limiter on auth endpoints to blunt credential stuffing / brute force,
// plus a broad limiter across the rest of the API to curb abuse and scraping.
const limiter = (windowMs: number, max: number) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // The suite hammers these endpoints from one IP; the limiter is a
    // production protection, not something worth mocking around.
    skip: (req) =>
      !!process.env.VITEST || (bypassLocalIps && isLocalIp(req.ip ?? "")),
    message: {
      success: false,
      error: "Too many requests, please try again later",
    },
  })

app.use("/api/auth", limiter(15 * 60 * 1000, 20))
app.use("/api", limiter(60 * 1000, 200))

// Body parsing comes AFTER the limiters, so a flood is rejected before the
// box pays to buffer and JSON.parse the payload. The program-upload cap is
// also gated on authenticateToken: at 2 MB it's 40x the global limit, and an
// anonymous caller has no business making the server parse that (the token
// check fails on jwt.verify without touching the DB). Mounted ahead of the
// global 50kb parser, which skips bodies express.json has already parsed.
app.use(
  "/api/program/upload",
  authenticateToken,
  express.json({ limit: "2mb" }),
)
app.use(express.json({ limit: "50kb" }))

app.get("/healthz", async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1")
    res.json({ status: "OK", fqdn: process.env.SERVER_FQDN || null })
  } catch {
    res.status(503).json({ status: "DOWN" })
  }
})

registerRoutes(app)

// After the routes, not before: mounted up front this stat()'d public/ for
// every API request that would never match a file. Public URLs (the APK) are
// unchanged — nothing under /api resolves here, so static only sees paths no
// route claimed.
app.use(express.static("public"))

app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: "Route not found" })
})

app.use(errorHandler)

const server = http.createServer(app)

// Advertised unconditionally — a client on the same LAN can find this box even
// without SERVER_FQDN set; on a cloud/Docker host it's simply unreachable via
// mDNS, which is harmless.
// multicast-dns has no reliable way to pick the "real" LAN NIC on its own —
// on a machine with Docker/WSL/VirtualBox/Hyper-V adapters it can bind
// multicast to one of those instead, so the announcement never reaches the
// actual Wi-Fi/Ethernet network.
function getLanInterface(): string | undefined {
  const virtualAdapter = /loopback|vEthernet|VirtualBox|Virtual|VPN|Tailscale|ZeroTier|Docker/i
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (virtualAdapter.test(name)) continue
    const ipv4 = addrs?.find((a) => a.family === "IPv4" && !a.internal)
    if (ipv4) return ipv4.address
  }
  return undefined
}

// Created in start() (not at import time) so importing app in tests doesn't
// open a multicast socket. `interface` is a real multicast-dns option that
// bonjour-service forwards but omits from its own (mistyped) ServiceConfig.
let bonjour: Bonjour | undefined
let mdnsService: Service | undefined

async function start() {
  await testDatabaseConnection()
  createWsServer(server)
  const b = new Bonjour({
    interface: getLanInterface(),
  } as ConstructorParameters<typeof Bonjour>[0])
  bonjour = b
  server.listen(PORT, () => {
    logger.info(`🚀 OwnLift Server v${packageJson.version} running on port ${PORT}`)
    startStaleSessionCleanup()

    mdnsService = b.publish({
      name: "OwnLift Server",
      type: "ownlift",
      port: Number(PORT),
      txt: { fqdn: process.env.SERVER_FQDN || "" },
    })
    logger.info(
      `📡 Advertising via mDNS as _ownlift._tcp${
        process.env.SERVER_FQDN ? ` (fqdn: ${process.env.SERVER_FQDN})` : ""
      }`,
    )
  })
}

function shutdown(exitCode: number) {
  closeWsServer()
  stopStaleSessionCleanup()
  if (mdnsService) mdnsService.stop()
  bonjour?.destroy()
  server.close(async () => {
    try {
      await pool.end()
    } catch (err) {
      logger.error("Error closing DB pool:", err)
    }
    process.exit(exitCode)
  })
}

// Only boot when run directly (node server.ts / tsx server.ts), so tests can
// import app without side effects. pathToFileURL makes relative launch
// scripts (e.g. `tsx server.ts`) compare equal to import.meta.url.
const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  start().catch((err) => {
    logger.error("Failed to start server:", err)
    process.exit(1)
  })

  process.on("SIGTERM", () => {
    logger.info("SIGTERM received — shutting down gracefully")
    shutdown(0)
  })

  process.on("SIGINT", () => {
    shutdown(0)
  })

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection:", reason)
    shutdown(1)
  })

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception:", err)
    shutdown(1)
  })
}
