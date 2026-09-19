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
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)
if (allowedOrigins.length === 0)
  throw new Error(
    "ALLOWED_ORIGINS env var is not set — set it to a comma-separated list of allowed origins (e.g. https://yourapp.com)",
  )
// cors compares each array entry as an exact string, so "*" inside the list is
// never a wildcard: it matches no origin at all and every browser request
// fails CORS with no boot error to explain it.
if (allowedOrigins.includes("*"))
  throw new Error(
    "ALLOWED_ORIGINS does not support \"*\" — list the origins explicitly, comma-separated (e.g. https://yourapp.com,http://localhost:3000)",
  )

// Number("true") is NaN, and Express's trust-proxy check (`hop < value`) is
// false for NaN — so a misspelled value silently behaves like 0 and collapses
// every client into one rate-limit bucket. Fail at boot instead.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0)
if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0)
  throw new Error(
    `TRUST_PROXY_HOPS must be a non-negative integer (got "${process.env.TRUST_PROXY_HOPS}") — 0 when the port is exposed directly, 1 behind a single reverse proxy`,
  )

import { testDatabaseConnection, pool } from "./config/database.js"
import { createWsServer, closeWsServer } from "./ws/wsServer.js"
import { registerRoutes, localOnlyFeatures } from "./routes.js"
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
app.set("trust proxy", trustProxyHops)

// This is a JSON API with no HTML views, so lock CSP down to "load nothing"
// rather than the browser-page-oriented defaults helmet ships with.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"] },
    },
  }),
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

// Loopback/private-range check for RATE_LIMIT_BYPASS_LOCAL_IPS. req.ip is the
// real client IP only when TRUST_PROXY_HOPS matches the deployment — behind a
// same-host proxy with the default 0 it is 127.0.0.1 for *everyone*, which
// would turn this bypass into "no rate limiting at all". See the boot warning
// below.
const isLocalIp = (ip: string) =>
  /^(127\.|10\.|192\.168\.|::1$|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.)/.test(
    ip,
  ) ||
  /^(172\.(1[6-9]|2\d|3[01])\.|::ffff:172\.(1[6-9]|2\d|3[01])\.)/.test(ip)

const bypassLocalIps = process.env.RATE_LIMIT_BYPASS_LOCAL_IPS === "true"

if (bypassLocalIps && trustProxyHops === 0)
  logger.warn(
    "⚠ RATE_LIMIT_BYPASS_LOCAL_IPS=true with TRUST_PROXY_HOPS=0. If this server " +
      "sits behind a reverse proxy, every request looks like 127.0.0.1 and BOTH " +
      "rate limiters are disabled for the entire internet. Set TRUST_PROXY_HOPS=1 " +
      "if proxied, or unset RATE_LIMIT_BYPASS_LOCAL_IPS.",
  )

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
// POST /api/sharing/permissions with permissionType "program" carries the
// same document /api/program/upload does, so it needs the same ceiling — at
// 50kb a program with machineMeta notes failed with a raw body-parser 413.
for (const path of ["/api/program/upload", "/api/sharing/permissions"])
  app.use(path, authenticateToken, express.json({ limit: "2mb" }))
app.use(express.json({ limit: "50kb" }))

// express.json leaves req.body undefined when no body (or no Content-Type)
// arrived; a route reading req.body.x then throws a TypeError that the error
// handler reports as a 500 for what is a 400. Normalize once, here.
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.body ??= {}
  next()
})

// Unauthenticated and outside the /api limiters, so a flood would otherwise
// take one of the pool's 8 connections per hit. The Docker healthcheck polls
// every 30s, so a few seconds of staleness costs nothing.
let dbProbe: { at: number; ok: boolean } = { at: 0, ok: false }
const DB_PROBE_TTL_MS = 5_000

app.get("/healthz", async (_req: Request, res: Response) => {
  if (Date.now() - dbProbe.at > DB_PROBE_TTL_MS) {
    let ok = true
    try {
      await pool.query("SELECT 1")
    } catch {
      ok = false
    }
    dbProbe = { at: Date.now(), ok }
  }
  if (!dbProbe.ok) return void res.status(503).json({ status: "DOWN" })
  res.json({
    status: "OK",
    fqdn: process.env.SERVER_FQDN || null,
    localOnlyFeatures,
  })
})

registerRoutes(app)

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
  // Backstop: a connection that refuses to end must not hold the process
  // hostage after a signal.
  setTimeout(() => process.exit(exitCode), 5000).unref()
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
