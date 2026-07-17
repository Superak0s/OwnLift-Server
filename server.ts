// src/server.ts
import express, { Request, Response, NextFunction } from "express"
import http from "http"
import cors from "cors"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
import dotenv from "dotenv"
import { randomUUID } from "crypto"
import { version } from "./package.json"
import { startStaleSessionCleanup } from "./jobs/sessionCleanup"

dotenv.config()

// ─── Fail fast on missing critical env vars ───────────────────────────────────
if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET env var is not set")
if (process.env.JWT_SECRET.length < 32)
  throw new Error(
    "JWT_SECRET is too weak — use at least 32 characters of high-entropy randomness",
  )
if (!process.env.ALLOWED_ORIGINS)
  throw new Error(
    "ALLOWED_ORIGINS env var is not set — set it to a comma-separated list of allowed origins (e.g. https://yourapp.com)",
  )

import { testDatabaseConnection } from "./config/database"
import { createWsServer } from "./ws/wsServer"
import { registerRoutes } from "./routes"
import { errorHandler } from "./middleware/errorHandler"

// ─── Extend Express Request with reqId ───────────────────────────────────────
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

const app = express()
const PORT = process.env.PORT || 5000

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet())

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS.split(",").map((o) =>
  o.trim(),
)
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
)

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "50kb" }))
app.use(express.static("public"))

// ─── Request ID ───────────────────────────────────────────────────────────────
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.reqId = randomUUID()
  next()
})

// ─── Request logger (no query params, no body) ────────────────────────────────
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${req.method}] ${req.path}`, {
    auth: req.headers.authorization ? "present" : "missing",
    reqId: req.reqId,
  })
  next()
})

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Strict limiter on auth endpoints to blunt credential stuffing / brute force,
// plus a broad limiter across the rest of the API to curb abuse and scraping.
app.use(
  "/api/auth",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: "Too many requests, please try again later",
    },
  }),
)

app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: "Too many requests, please try again later",
    },
  }),
)

// ─── Routes ───────────────────────────────────────────────────────────────────
registerRoutes(app)

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: "Route not found" })
})

// ─── Global error handler ─────────────────────────────────────────────────────
app.use(errorHandler)

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(app)
createWsServer(server)

async function start() {
  await testDatabaseConnection()
  server.listen(PORT, () => {
    console.log(`🚀 OwnLift Server v${version} running on port ${PORT}`)
    startStaleSessionCleanup()
  })
}

start().catch((err) => {
  console.error("Failed to start server:", err)
  process.exit(1)
})

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("SIGTERM received — shutting down gracefully")
  server.close(() => {
    console.log("Server closed")
    process.exit(0)
  })
})

process.on("SIGINT", () => {
  server.close(() => process.exit(0))
})
