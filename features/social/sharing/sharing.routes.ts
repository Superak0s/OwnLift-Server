import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { parseMySQLDate } from "@/config/database.js"
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from "@/middleware/errorHandler.js"
import {
  sendToUser,
  notifyJointProgress,
} from "@/ws/wsServer.js"
import {
  grantPermission,
  revokePermission,
  getPermissions,
  hasPermission,
  getFriendSessions,
  getFriendSessionDetails,
  createJointInvite,
  getInvite,
  acceptInvite,
  declineInvite,
  getJointSession,
  updateParticipantProgress,
  endJointSession,
  getUserActiveSessionStatus,
} from "./sharing.model.js"
import { areFriends } from "../friends/friends.model.js"
import { queryLimit, parseIntParam } from "@/middleware/validation.js"

const router: Router = Router()

/**
 * The friendship check and the permission check are independent reads, so run
 * them together — every friend-scoped route below used to pay two serial round
 * trips before it started doing any actual work. Callers keep their own
 * wording for the two failures.
 */
const friendAccess = (
  viewerId: number,
  friendId: number,
  permission: "history" | "watch_session",
) =>
  Promise.all([
    areFriends(viewerId, friendId),
    hasPermission(friendId, viewerId, permission),
  ])

/**
 * Who is currently watching whose live session.
 *
 * There is no "stop watching" call — the app just stops polling the live
 * route — so a watch is held open by polling and expires on silence. In-process
 * state, like the WS rate counters: this server is single-instance, and a
 * restart only costs a watcher one `watch_started` on their next poll.
 */
const WATCH_IDLE_MS = 60_000

interface Watch {
  watcherId: number
  watcherUsername: string
  friendId: number
  sessionId: number
  since: Date
  timer: NodeJS.Timeout
}

const activeWatches = new Map<string, Watch>()

function noteWatch(
  watcherId: number,
  watcherUsername: string,
  friendId: number,
  sessionId: number,
): void {
  const key = `${watcherId}:${sessionId}`
  const existing = activeWatches.get(key)

  // unref: a pending expiry must never be the reason the process (or a test
  // run) stays alive.
  const timer = setTimeout(() => {
    activeWatches.delete(key)
    sendToUser(friendId, "watch_stopped", {
      watcherId,
      watcherUsername,
      sessionId,
    })
  }, WATCH_IDLE_MS)
  timer.unref()

  if (existing) {
    // Every poll refreshes the deadline, but only the first one announces the
    // watcher — otherwise the owner gets a notification every few seconds.
    clearTimeout(existing.timer)
    activeWatches.set(key, { ...existing, timer })
    return
  }

  activeWatches.set(key, {
    watcherId,
    watcherUsername,
    friendId,
    sessionId,
    since: new Date(),
    timer,
  })
  sendToUser(friendId, "watch_started", {
    watcherId,
    watcherUsername,
    sessionId,
  })
}

router.use(authenticateToken)

router.post("/permissions", async (req: Request, res: Response) => {
  const { friendId, permissionType, payload } = req.body

  if (!friendId) throw new ValidationError("friendId is required")
  if (!permissionType) throw new ValidationError("permissionType is required")

  if (permissionType === "program" && !payload?.programData) {
    throw new ValidationError(
      "payload.programData is required for program permission",
    )
  }

  const parsedFriendId = parseIntParam(String(friendId), "friendId")

  if (!(await areFriends(req.user!.id, parsedFriendId))) {
    throw new ForbiddenError("Can only grant permissions to friends")
  }

  const permissionId = await grantPermission(
    req.user!.id,
    parsedFriendId,
    permissionType,
    payload ?? null,
  )

  res
    .status(201)
    .json({ success: true, message: "Permission granted", permissionId })
})

router.get("/permissions/granted", async (req: Request, res: Response) => {
  const permissions = await getPermissions(req.user!.id, "granted")
  res.json({ success: true, permissions })
})

router.get("/permissions/received", async (req: Request, res: Response) => {
  const permissions = await getPermissions(req.user!.id, "received")
  res.json({ success: true, permissions })
})

router.delete("/permissions/:permissionId", async (req: Request, res: Response) => {
  const permissionId = parseIntParam(String(req.params.permissionId), "permissionId")
  await revokePermission(req.user!.id, permissionId)
  res.json({ success: true, message: "Permission revoked" })
})

router.get("/sessions/friend/:friendId", async (req: Request, res: Response) => {
  const friendId = parseIntParam(String(req.params.friendId), "friendId")
  const limit = queryLimit(req, { def: 60, max: 200 })

  const [friends, allowed] = await friendAccess(req.user!.id, friendId, "history")
  if (!friends) throw new ForbiddenError("Can only view sessions of friends")
  if (!allowed)
    throw new ForbiddenError("Friend hasn't granted you history access")

  const sessions = await getFriendSessions(friendId, limit)
  res.json({ success: true, sessions })
})

router.get("/sessions/friend/:friendId/:sessionId", async (req: Request, res: Response) => {
  const friendId = parseIntParam(String(req.params.friendId), "friendId")
  const sessionId = parseIntParam(String(req.params.sessionId), "sessionId")

  const [friends, allowed] = await friendAccess(req.user!.id, friendId, "history")
  if (!friends) throw new ForbiddenError("Can only view sessions of friends")
  if (!allowed)
    throw new ForbiddenError("Friend hasn't granted you history access")

  const session = await getFriendSessionDetails(friendId, sessionId)
  if (!session) throw new NotFoundError("Session")

  res.json({ success: true, session })
})

router.get("/joint-sessions/friend/:friendId/status", async (req: Request, res: Response) => {
  const friendId = parseIntParam(String(req.params.friendId), "friendId")

  if (!(await areFriends(req.user!.id, friendId)))
    throw new ForbiddenError("Not friends")

  const status = await getUserActiveSessionStatus(friendId)
  res.json({ success: true, ...status })
})

router.post("/joint-sessions/invite", async (req: Request, res: Response) => {
  const { toUserId } = req.body

  if (!toUserId) throw new ValidationError("toUserId is required")
  const parsedToUserId = parseIntParam(String(toUserId), "toUserId")

  if (!(await areFriends(req.user!.id, parsedToUserId)))
    throw new ForbiddenError("Can only invite friends")

  const myStatus = await getUserActiveSessionStatus(req.user!.id)
  if (!myStatus.hasActiveSession) {
    throw new ValidationError(
      "You must have an active workout session to send a joint invite",
    )
  }

  const inviteId = await createJointInvite(
    req.user!.id,
    parsedToUserId,
    myStatus.sessionId,
  )

  sendToUser(parsedToUserId, "joint_invite", {
    inviteId,
    fromUserId: req.user!.id,
    fromUsername: req.user!.username,
    fromSessionId: myStatus.sessionId,
  })

  res.status(201).json({ success: true, inviteId })
})

router.post("/joint-sessions/invites/:inviteId/accept", async (req: Request, res: Response) => {
  const inviteId = parseIntParam(String(req.params.inviteId), "inviteId")

  const invite = await getInvite(inviteId)
  if (!invite || parseMySQLDate(invite.expires_at) < new Date())
    throw new NotFoundError("Invite")
  if (invite.to_user_id !== req.user!.id)
    throw new ForbiddenError("This invite is not for you")

  const myStatus = await getUserActiveSessionStatus(req.user!.id)
  if (!myStatus.hasActiveSession) {
    throw new ValidationError(
      "You must have an active workout session to join a joint session",
    )
  }

  const { jointSessionId } = await acceptInvite(
    inviteId,
    req.user!.id,
    myStatus.sessionId,
  )

  const jointSession = await getJointSession(jointSessionId)
  if (!jointSession) throw new Error("Joint session not found after accept")

  const sender = jointSession.participants.find(
    (p: any) => p.userId !== req.user!.id,
  )
  if (sender)
    sendToUser(sender.userId, "invite_status", {
      status: "accepted",
      jointSession,
    })

  res.json({ success: true, jointSession })
})

router.post("/joint-sessions/invites/:inviteId/decline", async (req: Request, res: Response) => {
  const inviteId = parseIntParam(String(req.params.inviteId), "inviteId")
  const invite = await getInvite(inviteId)

  await declineInvite(inviteId, req.user!.id)

  if (invite)
    sendToUser(invite.from_user_id, "invite_status", {
      status: "declined",
      jointSession: null,
    })
  res.json({ success: true, message: "Invite declined" })
})

router.patch("/joint-sessions/:jointSessionId/progress", async (req: Request, res: Response) => {
  const {
    exerciseIndex,
    setIndex,
    exerciseName,
    readyForNext,
    exerciseNames,
  } = req.body
  const jointSessionId = parseIntParam(
    String(req.params.jointSessionId),
    "jointSessionId",
  )

  // Broadcast the stored values, not the raw body: updateParticipantProgress
  // sanitises out-of-range indices, so the two disagreed.
  const stored = await updateParticipantProgress(jointSessionId, req.user!.id, {
    exerciseIndex: exerciseIndex ?? null,
    setIndex: setIndex ?? null,
    exerciseName: exerciseName ?? null,
    readyForNext: readyForNext || false,
    exerciseNames: exerciseNames ?? null,
  })

  const session = await getJointSession(jointSessionId)
  if (session) notifyJointProgress(session, req.user!.id, stored)

  res.json({ success: true })
})

router.delete("/joint-sessions/:jointSessionId/leave", async (req: Request, res: Response) => {
  const jointSessionId = parseIntParam(
    String(req.params.jointSessionId),
    "jointSessionId",
  )
  const session = await getJointSession(jointSessionId)

  await endJointSession(jointSessionId, req.user!.id)

  if (session) {
    const partner = session.participants.find(
      (p: any) => p.userId !== req.user!.id,
    )
    if (partner)
      sendToUser(partner.userId, "invite_status", {
        status: "session_ended",
        jointSession: null,
      })
  }

  res.json({ success: true, message: "Left joint session" })
})

router.get("/watch/friend/:friendId/active", async (req: Request, res: Response) => {
  const friendId = parseIntParam(String(req.params.friendId), "friendId")

  const [friends, allowed] = await friendAccess(
    req.user!.id,
    friendId,
    "watch_session",
  )
  if (!friends) throw new ForbiddenError("Not friends")
  if (!allowed)
    throw new ForbiddenError("Friend hasn't granted you watch session access")

  const status = await getUserActiveSessionStatus(friendId)
  if (!status.hasActiveSession) throw new NotFoundError("Active session")

  res.json({ success: true, session: { sessionId: status.sessionId } })
})

router.get("/watch/friend/:friendId/session/:sessionId/live", async (req: Request, res: Response) => {
  const friendId = parseIntParam(String(req.params.friendId), "friendId")
  const sessionId = parseIntParam(String(req.params.sessionId), "sessionId")

  const [friends, allowed] = await friendAccess(
    req.user!.id,
    friendId,
    "watch_session",
  )
  if (!friends) throw new ForbiddenError("Not friends")
  if (!allowed) throw new ForbiddenError("No watch permission")

  const status = await getUserActiveSessionStatus(friendId)
  if (!status.hasActiveSession || status.sessionId !== sessionId)
    throw new NotFoundError("Active session")

  const session = await getFriendSessionDetails(friendId, sessionId)
  if (!session) throw new NotFoundError("Session")

  // Only after every access check: a caller who can't watch never registers as
  // a watcher, and the owner is never told about them.
  noteWatch(req.user!.id, req.user!.username, friendId, sessionId)

  res.json({ success: true, liveSession: session })
})

export default router
