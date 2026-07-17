// src/ws/wsServer.ts
import { WebSocketServer, WebSocket, RawData } from "ws"
import http from "http"
import jwt from "jsonwebtoken"
import { randomUUID } from "crypto"
import { pool } from "../config/database"
import {
  getJointSession,
  updateParticipantProgress,
} from "../models/social/sharing"
import type { JointSession, ParticipantProgress, JwtPayload } from "../types"

// ─── Types ────────────────────────────────────────────────────────────────────

interface WsUser {
  id: number
  username: string
}

export interface ProgressPayload extends ParticipantProgress {
  fromUserId?: number
}

interface WsMessage {
  type: string
  token?: string
  jointSessionId?: number
  progress?: ProgressPayload
}

interface ExtendedWebSocket extends WebSocket {
  _pongReceived?: boolean
  _userId?: number
  _authenticated?: boolean
  _authTimeout?: NodeJS.Timeout
  _preAuthMsgCount?: number
}

// ─── One-time WS ticket store ─────────────────────────────────────────────────
//
// Rather than passing the long-lived JWT in the URL (visible in server logs and
// HTTP proxies), clients first call POST /api/auth/ws-ticket to get a
// short-lived, single-use ticket and present that in the WS handshake URL.
//
// ⚠️  NOTE: This store is in-process memory. On a single-process deployment
// this is fine. If you ever run multiple Node processes (PM2 cluster, k8s with
// multiple replicas) you MUST move this to a shared store (Redis, DB table)
// or tickets issued by one process will not be found by another.

interface Ticket {
  userId: number
  expiresAt: number // epoch ms
}

const wsTickets = new Map<string, Ticket>()
const TICKET_TTL_MS = 30_000 // 30 seconds — enough time to open the socket

export function issueWsTicket(userId: number): string {
  const ticket = randomUUID()
  wsTickets.set(ticket, { userId, expiresAt: Date.now() + TICKET_TTL_MS })
  // Expire stale tickets lazily on each issue (low frequency operation)
  for (const [k, v] of wsTickets) {
    if (v.expiresAt < Date.now()) wsTickets.delete(k)
  }
  return ticket
}

function consumeWsTicket(ticket: string): number | null {
  const t = wsTickets.get(ticket)
  if (!t) return null
  wsTickets.delete(ticket) // single-use
  if (t.expiresAt < Date.now()) return null
  return t.userId
}

// ─── Connection registry ──────────────────────────────────────────────────────

const clients = new Map<number, WebSocket>()

// Per-user message counter for rate limiting (messages in the last second)
// ⚠️  NOTE: Also in-process memory — same multi-instance caveat as wsTickets.
const msgCount = new Map<number, number>()
const MAX_MSG_BYTES = 8 * 1024 // 8 KB per message
const MAX_MSG_PER_SEC = 20
const MAX_PREAUTH_MSGS = 10 // messages allowed before authenticating

// Heartbeat interval — ping every connected client every 30 s.
const PING_INTERVAL_MS = 30_000
const PONG_TIMEOUT_MS = 10_000 // eslint-disable-line @typescript-eslint/no-unused-vars

// ─── Helpers ──────────────────────────────────────────────────────────────────

function send(ws: WebSocket | undefined, type: string, payload: object): void {
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type, ...payload }))
}

function sendToUser(userId: number, type: string, payload: object): void {
  send(clients.get(userId), type, payload)
}

async function authenticateWs(req: http.IncomingMessage): Promise<WsUser> {
  const params = new URL(req.url!, "ws://localhost").searchParams

  // One-time ticket only. Raw JWT-in-URL auth was removed — the long-lived
  // token would otherwise land in server/proxy access logs. Clients without a
  // ticket must authenticate via the post-connection `auth` message instead.
  const ticket = params.get("ticket")
  if (!ticket) throw new Error("No ticket")
  const userId = consumeWsTicket(ticket)
  if (userId === null) throw new Error("Invalid or expired ticket")

  const [users] = await pool.execute<any[]>(
    "SELECT id, username FROM users WHERE id = ?",
    [userId],
  )
  if (!users[0]) throw new Error("User not found")
  return users[0] as WsUser
}

// ─── Message handlers ─────────────────────────────────────────────────────────

async function handlePushJointProgress(
  ws: WebSocket,
  user: WsUser,
  data: WsMessage,
): Promise<void> {
  const { jointSessionId, progress } = data
  if (!jointSessionId) return

  const session: JointSession | null = await getJointSession(jointSessionId)
  if (!session || !session.participants.some((p) => p.userId === user.id))
    return send(ws, "error", { message: "Not a participant" })

  await updateParticipantProgress(jointSessionId, user.id, {
    exerciseIndex: progress?.exerciseIndex ?? null,
    setIndex: progress?.setIndex ?? null,
    exerciseName: progress?.exerciseName ?? null,
    readyForNext: progress?.readyForNext || false,
    selectedPerson: progress?.selectedPerson ?? null,
    exerciseNames: progress?.exerciseNames ?? null,
  })

  const partner = session.participants.find((p) => p.userId !== user.id)
  if (partner)
    sendToUser(partner.userId, "joint_progress", {
      jointSessionId,
      progress: { ...progress, fromUserId: user.id },
    })
}

async function handleLeaveJointSession(
  _ws: WebSocket,
  user: WsUser,
  data: WsMessage,
): Promise<void> {
  const { jointSessionId } = data
  if (!jointSessionId) return
  const session = await getJointSession(jointSessionId)
  if (!session) return
  // Only a participant may end the session — otherwise any authenticated client
  // could end arbitrary sessions by iterating the numeric id (IDOR).
  if (!session.participants.some((p) => p.userId === user.id)) return
  await pool.execute(
    "UPDATE joint_sessions SET status = 'ended' WHERE id = ?",
    [jointSessionId],
  )
  const partner = session.participants.find((p) => p.userId !== user.id)
  if (partner)
    sendToUser(partner.userId, "joint_session_ended", { jointSessionId })
}

// ─── Exported notify helpers (called from REST routes) ───────────────────────

export const notifyJointInvite = (toUserId: number, invite: object) =>
  sendToUser(toUserId, "joint_invite", invite)
export const notifyInviteStatus = (
  toUserId: number,
  status: string,
  jointSession: object | null = null,
) => sendToUser(toUserId, "invite_status", { status, jointSession })
export const notifyFriendRequest = (toUserId: number, request: object) =>
  sendToUser(toUserId, "friend_request_received", request)
export const notifyWatcher = (watcherUserId: number, sessionSnapshot: object) =>
  sendToUser(watcherUserId, "live_session_update", {
    liveSession: sessionSnapshot,
  })
export const pushSessionStatus = (
  toUserId: number,
  type: string,
  payload: object,
) => sendToUser(toUserId, type, payload)

export function notifyJointProgress(
  session: JointSession,
  fromUserId: number,
  progress: ProgressPayload,
): void {
  const partner = session.participants.find((p) => p.userId !== fromUserId)
  if (partner)
    sendToUser(partner.userId, "joint_progress", {
      jointSessionId: session.id,
      progress: { ...progress, fromUserId },
    })
}

// ─── Connection setup helper ──────────────────────────────────────────────────

function setupAuthenticatedConnection(
  ws: WebSocket,
  extWs: ExtendedWebSocket,
  user: WsUser,
) {
  // Close any existing socket for this user (prevent zombie connections)
  const existing = clients.get(user.id)
  if (existing && existing.readyState === WebSocket.OPEN) {
    existing.close(1000, "Replaced by new connection")
  }

  clients.set(user.id, ws)
  console.log(`[WS] connection ready uid=${user.id} (${user.username})`)

  ws.on("pong", () => {
    extWs._pongReceived = true
  })
}

// ─── Server setup ─────────────────────────────────────────────────────────────

export function createWsServer(httpServer: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" })

  // ── Heartbeat: ping all live clients every PING_INTERVAL_MS ──────────────
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const ext = ws as ExtendedWebSocket
      if (ext._pongReceived === false) {
        console.warn(`[WS] terminating stale connection uid=${ext._userId}`)
        ws.terminate()
        return
      }
      ext._pongReceived = false
      ws.ping()
    })
  }, PING_INTERVAL_MS)

  wss.on("close", () => clearInterval(heartbeat))

  wss.on("connection", async (ws: WebSocket, req: http.IncomingMessage) => {
    const extWs = ws as ExtendedWebSocket
    extWs._pongReceived = true
    extWs._authenticated = false

    console.log("[WS] connection attempt from", req.socket.remoteAddress)

    // Try to authenticate from URL (for backwards compat with ticket/token in URL)
    let user: WsUser | null = null
    try {
      user = await authenticateWs(req)
      extWs._authenticated = true
      extWs._userId = user.id
      console.log(`[WS] authenticated via URL uid=${user.id}`)
    } catch (err) {
      const msg = (err as Error).message
      console.log("[WS] no URL auth, expecting auth message:", msg)

      // Don't close immediately — wait for auth message
      // Set a timeout: if no auth message arrives in 5s, close
      const authTimeout = setTimeout(() => {
        if (!extWs._authenticated) {
          console.warn("[WS] auth timeout, no auth message received")
          ws.close(4001, "Unauthorized: No auth message")
        }
      }, 5000)

      extWs._authTimeout = authTimeout
    }

    // If already authenticated via URL, proceed with normal setup
    if (user) {
      setupAuthenticatedConnection(ws, extWs, user)
    }

    ws.on("message", async (raw: RawData) => {
      const rawStr = raw.toString()

      // Guard: message size. Measure bytes (not JS string length, which
      // under-counts multi-byte characters).
      if (Buffer.byteLength(rawStr, "utf8") > MAX_MSG_BYTES) {
        send(ws, "error", { message: "Message too large" })
        return
      }

      let msg: WsMessage
      try {
        msg = JSON.parse(rawStr)
      } catch (err) {
        console.warn("[WS] failed to parse message:", (err as Error).message)
        return
      }

      // Cap unauthenticated chatter — otherwise a client can flood messages for
      // the whole 5s auth window. NB: never log raw message bodies; the `auth`
      // message carries the JWT.
      if (!extWs._authenticated) {
        extWs._preAuthMsgCount = (extWs._preAuthMsgCount ?? 0) + 1
        if (extWs._preAuthMsgCount > MAX_PREAUTH_MSGS) {
          ws.close(4001, "Unauthorized: too many messages before auth")
          return
        }
      }

      console.log("[WS] message type:", msg.type)

      // Handle auth message FIRST if not yet authenticated
      if (!extWs._authenticated && msg.type === "auth") {
        console.log("[WS] processing auth message")
        if (extWs._authTimeout) clearTimeout(extWs._authTimeout)

        try {
          if (!msg.token) {
            console.warn("[WS] auth message missing token")
            ws.close(4001, "Unauthorized: No token in auth message")
            return
          }

          console.log("[WS] verifying JWT token")
          const payload = jwt.verify(
            msg.token,
            process.env.JWT_SECRET as string,
            {
              algorithms: ["HS256"],
            },
          ) as JwtPayload

          const [users] = await pool.execute<any[]>(
            "SELECT id, username FROM users WHERE id = ?",
            [payload.userId],
          )

          if (!users[0]) {
            console.warn("[WS] user not found for userId:", payload.userId)
            ws.close(4001, "Unauthorized: User not found")
            return
          }

          user = users[0] as WsUser
          extWs._authenticated = true
          extWs._userId = user.id

          console.log(`[WS] authenticated via message uid=${user.id}`)
          send(ws, "auth_success", { userId: user.id })

          setupAuthenticatedConnection(ws, extWs, user)
        } catch (err) {
          console.error("[WS] auth failed:", err)
          if (err instanceof jwt.JsonWebTokenError) {
            ws.close(4001, `Unauthorized: ${err.message}`)
          } else {
            ws.close(4002, "Server error during auth")
          }
        }
        return
      }

      // All other messages require authentication
      if (!extWs._authenticated) {
        console.warn("[WS] message received before authentication:", msg.type)
        send(ws, "error", { message: "Not authenticated" })
        return
      }
      if (!user) {
        send(ws, "error", { message: "Not authenticated" })
        return
      }

      // TypeScript narrowing: user is guaranteed non-null here
      const authenticatedUser = user as WsUser

      // Guard: rate limit per user
      const count = (msgCount.get(authenticatedUser.id) ?? 0) + 1
      msgCount.set(authenticatedUser.id, count)
      setTimeout(() => {
        msgCount.set(
          authenticatedUser.id,
          Math.max(0, (msgCount.get(authenticatedUser.id) ?? 1) - 1),
        )
      }, 1000)
      if (count > MAX_MSG_PER_SEC) {
        send(ws, "error", { message: "Rate limit exceeded" })
        return
      }

      try {
        switch (msg.type) {
          case "push_joint_progress":
            await handlePushJointProgress(ws, authenticatedUser, msg)
            break
          case "leave_joint_session":
            await handleLeaveJointSession(ws, authenticatedUser, msg)
            break
          default:
            console.warn(`[WS] unknown type: ${msg.type}`)
        }
      } catch (err) {
        send(ws, "error", { message: (err as Error).message })
      }
    })

    ws.on("close", () => {
      // Only clear registry/counter entries if they still belong to THIS
      // socket — a replaced connection (same user, new socket) must not have
      // its live entries wiped by the old socket's close handler.
      if (user && clients.get(user.id) === ws) {
        clients.delete(user.id)
        msgCount.delete(user.id)
      }
      if (extWs._authTimeout) clearTimeout(extWs._authTimeout)
      console.log(`[WS] disconnected uid=${extWs._userId}`)
    })

    ws.on("error", (err: Error) =>
      console.error(`[WS] error uid=${extWs._userId}:`, err.message),
    )
  })

  // Clean up all connections on server shutdown
  process.on("SIGTERM", () => {
    clearInterval(heartbeat)
    clients.forEach((ws) => ws.close(1001, "Server shutting down"))
    clients.clear()
    msgCount.clear()
  })

  return wss
}
