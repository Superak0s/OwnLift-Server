import { WebSocketServer, WebSocket, RawData } from "ws"
import http from "http"
import jwt from "jsonwebtoken"
import { pool } from "../config/database.js"
import { findUserForAuth } from "../features/auth/auth.model.js"
import { logger } from "../utils/logger.js"
import {
  getJointSession,
  updateParticipantProgress,
} from "../features/social/sharing/sharing.model.js"
import type { JointSession, ParticipantProgress } from "../features/social/social.types.js"
import type { JwtPayload } from "../features/auth/auth.types.js"

interface WsUser {
  id: number
  username: string
}

interface ProgressPayload extends ParticipantProgress {
  fromUserId?: number
}

interface WsMessage {
  type: string
  token?: string
  jointSessionId?: number
  progress?: ProgressPayload
}

// Only the state the heartbeat sweep needs — it runs outside the
// per-connection closure, so it cannot reach that scope. Everything else
// (auth timer, pre-auth message count) stays closure-local.
interface ExtendedWebSocket extends WebSocket {
  _pongReceived?: boolean
  _userId?: number
}

const clients = new Map<number, WebSocket>()

// Per-user message counter for rate limiting (messages in the last second)
// ⚠️  NOTE: In-process memory, so this server is single-instance only. Running
// multiple Node processes (PM2 cluster, k8s replicas) needs a shared store.
const msgCount = new Map<number, number>()

function send(ws: WebSocket | undefined, type: string, payload: object): void {
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type, ...payload }))
}

function sendToUser(userId: number, type: string, payload: object): void {
  send(clients.get(userId), type, payload)
}

/**
 * Whether anyone other than `userId` currently holds a socket.
 *
 * The live-set fan-out queries (getSessionWatchers, getActiveTrainers) are
 * two-table joins with an OR-ed friendship predicate, and they ran on every
 * single recorded set — including on a one-person instance, where the lifter's
 * own socket is the only one open and there is by definition nobody to deliver
 * to. Checking the map first skips both.
 */
export function hasOtherClients(userId: number): boolean {
  for (const id of clients.keys()) if (id !== userId) return true
  return false
}

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
    exerciseNames: progress?.exerciseNames ?? null,
  })

  notifyJointProgress(session, user.id, progress ?? {})
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

export { sendToUser }

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

// Set by createWsServer; called from server.ts's shutdown() so SIGINT (not
// just SIGTERM) also closes WS connections gracefully.
let wsCleanup: (() => void) | null = null

export function closeWsServer(): void {
  wsCleanup?.()
}

export function createWsServer(httpServer: http.Server): WebSocketServer {
  // maxPayload, not just the 8KB check in the message handler below: ws
  // defaults to 100 MB and buffers the entire frame before any handler runs,
  // so without this an unauthenticated socket could make the box allocate
  // 100 MB (twice, counting raw.toString()) before the size guard, the 5s auth
  // timeout or the pre-auth message cap had a chance to fire.
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: 8 * 1024,
  })

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const ext = ws as ExtendedWebSocket
      if (ext._pongReceived === false) {
        logger.warn(`[WS] terminating stale connection uid=${ext._userId}`)
        ws.terminate()
        return
      }
      ext._pongReceived = false
      ws.ping()
    })
  }, 30_000)

  wss.on("close", () => clearInterval(heartbeat))

  wss.on("connection", async (ws: WebSocket, req: http.IncomingMessage) => {
    const extWs = ws as ExtendedWebSocket
    extWs._pongReceived = true

    logger.info("[WS] connection attempt from", req.socket.remoteAddress)

    // Auth happens over the socket, never in the handshake URL — a long-lived
    // JWT in the URL would land in server and proxy access logs. Set by the
    // `auth` message handler below, then read by every later message.
    let user: WsUser | null = null
    let preAuthMsgCount = 0

    const authTimeout = setTimeout(() => {
      if (!user) {
        logger.warn("[WS] auth timeout, no auth message received")
        ws.close(4001, "Unauthorized: No auth message")
      }
    }, 5_000)

    ws.on("message", async (raw: RawData) => {
      const rawStr = raw.toString()

      // Guard: message size. Measure bytes (not JS string length, which
      // under-counts multi-byte characters).
      if (Buffer.byteLength(rawStr, "utf8") > 8 * 1024) {
        send(ws, "error", { message: "Message too large" })
        return
      }

      let msg: WsMessage
      try {
        msg = JSON.parse(rawStr)
      } catch (err) {
        logger.warn("[WS] failed to parse message:", (err as Error).message)
        return
      }

      // Cap unauthenticated chatter — otherwise a client can flood messages for
      // the whole 5s auth window. NB: never log raw message bodies; the `auth`
      // message carries the JWT.
      if (!user) {
        preAuthMsgCount++
        if (preAuthMsgCount > 10) {
          ws.close(4001, "Unauthorized: too many messages before auth")
          return
        }
      }

      if (!user && msg.type === "auth") {
        logger.info("[WS] processing auth message")
        clearTimeout(authTimeout)

        try {
          if (!msg.token) {
            logger.warn("[WS] auth message missing token")
            ws.close(4001, "Unauthorized: No token in auth message")
            return
          }

          logger.info("[WS] verifying JWT token")
          const payload = jwt.verify(
            msg.token,
            process.env.JWT_SECRET as string,
            {
              algorithms: ["HS256"],
            },
          ) as JwtPayload

          const found = await findUserForAuth(payload.userId)

          if (!found) {
            logger.warn("[WS] user not found for userId:", payload.userId)
            ws.close(4001, "Unauthorized: User not found")
            return
          }

          if (found.tokenVersion !== payload.tokenVersion) {
            logger.warn("[WS] revoked token for userId:", payload.userId)
            ws.close(4001, "Unauthorized: Token has been revoked")
            return
          }

          user = { id: found.user.id, username: found.user.username }
          extWs._userId = user.id

          logger.info(`[WS] authenticated via message uid=${user.id}`)
          send(ws, "auth_success", { userId: user.id })

          // Close any existing socket for this user (prevent zombie connections)
          const existing = clients.get(user.id)
          if (existing && existing.readyState === WebSocket.OPEN)
            existing.close(1000, "Replaced by new connection")

          clients.set(user.id, ws)
          ws.on("pong", () => {
            extWs._pongReceived = true
          })
          logger.info(
            `[WS] connection ready uid=${user.id} (${user.username})`,
          )
        } catch (err) {
          logger.error("[WS] auth failed:", err)
          if (err instanceof jwt.JsonWebTokenError) {
            ws.close(4001, `Unauthorized: ${err.message}`)
          } else {
            ws.close(4002, "Server error during auth")
          }
        }
        return
      }

      // Copied to a const so it narrows to WsUser past this guard — TS won't
      // narrow `user` itself, since the auth branch above reassigns it.
      const authedUser = user
      if (!authedUser) {
        logger.warn("[WS] message received before authentication:", msg.type)
        send(ws, "error", { message: "Not authenticated" })
        return
      }

      // Guard: rate limit per user. Not a fixed window — each message adds 1
      // to the count and schedules its own -1 after 1s, so this is a decaying
      // counter (effectively "no more than MAX_MSG_PER_SEC in-flight per
      // rolling second"), not a hard per-clock-second bucket.
      const count = (msgCount.get(authedUser.id) ?? 0) + 1
      msgCount.set(authedUser.id, count)
      setTimeout(() => {
        // Only decrement a live entry. The close handler deletes the key, and
        // a timer still pending from a message sent in the last second would
        // otherwise re-insert it (?? 1 → max(0, 0) → set 0) and leak the
        // entry for the life of the process.
        if (!msgCount.has(authedUser.id)) return
        msgCount.set(
          authedUser.id,
          Math.max(0, (msgCount.get(authedUser.id) ?? 1) - 1),
        )
      }, 1000)
      if (count > 20) {
        // Tell the client why, then close. Replying alone left the socket
        // open, so a flooding client kept paying us to JSON.parse up to 8KB,
        // allocate a timer and write an error frame per message — the cap only
        // ever protected the DB-touching handlers below. A legitimate client
        // sends ~1 message per completed set, so this is ~90x its peak rate
        // and closing costs it nothing.
        send(ws, "error", { message: "Rate limit exceeded" })
        ws.close(4008, "Rate limit exceeded")
        return
      }

      try {
        switch (msg.type) {
          case "push_joint_progress":
            await handlePushJointProgress(ws, authedUser, msg)
            break
          case "leave_joint_session":
            await handleLeaveJointSession(ws, authedUser, msg)
            break
          default:
            logger.warn(`[WS] unknown type: ${msg.type}`)
        }
      } catch (err) {
        // Mirror the HTTP error handler's polarity: deliberate 4xx messages
        // are safe to return, anything else is masked. Without this a driver
        // error from the handlers below reached the client verbatim, leaking
        // schema detail that the REST surface masks in production.
        const status = (err as { statusCode?: number }).statusCode ?? 500
        logger.error(`[WS] ${msg.type} failed:`, (err as Error).message)
        send(ws, "error", {
          message: status < 500 ? (err as Error).message : "Server error",
        })
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
      clearTimeout(authTimeout)
      logger.info(`[WS] disconnected uid=${extWs._userId}`)
    })

    ws.on("error", (err: Error) =>
      logger.error(`[WS] error uid=${extWs._userId}:`, err.message),
    )
  })

  wsCleanup = () => {
    clearInterval(heartbeat)
    clients.forEach((ws) => ws.close(1001, "Server shutting down"))
    clients.clear()
    msgCount.clear()
  }

  return wss
}
