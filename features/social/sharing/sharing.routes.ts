import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
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
  getGrantedPermissions,
  getReceivedPermissions,
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

router.use(authenticateToken)

// Max size for a shared program payload stored in sharing_permissions.payload
const MAX_PROGRAM_PAYLOAD_BYTES = 512 * 1024

router.post("/permissions", async (req: Request, res: Response) => {
  const { friendId, permissionType, payload } = req.body

  if (!friendId) throw new ValidationError("friendId is required")
  if (!permissionType) throw new ValidationError("permissionType is required")

  if (permissionType === "program" && !payload?.programData) {
    throw new ValidationError(
      "payload.programData is required for program permission",
    )
  }
  // Guard against storing arbitrarily large payloads, for any permission type
  if (payload) {
    const payloadSize = Buffer.byteLength(JSON.stringify(payload), "utf8")
    if (payloadSize > MAX_PROGRAM_PAYLOAD_BYTES) {
      throw new ValidationError(
        `Payload exceeds the ${MAX_PROGRAM_PAYLOAD_BYTES / 1024} KB limit`,
      )
    }
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
  const permissions = await getGrantedPermissions(req.user!.id)
  res.json({ success: true, permissions, count: permissions.length })
})

router.get("/permissions/received", async (req: Request, res: Response) => {
  const permissions = await getReceivedPermissions(req.user!.id)
  res.json({ success: true, permissions, count: permissions.length })
})

router.delete("/permissions/:permissionId", async (req: Request, res: Response) => {
  const permissionId = parseIntParam(String(req.params.permissionId), "permissionId")
  await revokePermission(req.user!.id, permissionId)
  res.json({ success: true, message: "Permission revoked" })
})

router.get("/sessions/friend/:friendId", async (req: Request, res: Response) => {
  const friendId = parseIntParam(String(req.params.friendId), "friendId")
  const limit = queryLimit(req, { def: 60, max: 200 })

  if (!(await areFriends(req.user!.id, friendId)))
    throw new ForbiddenError("Can only view sessions of friends")
  if (!(await hasPermission(friendId, req.user!.id, "history")))
    throw new ForbiddenError("Friend hasn't granted you history access")

  const sessions = await getFriendSessions(friendId, limit)
  res.json({ success: true, sessions, count: sessions.length })
})

router.get("/sessions/friend/:friendId/:sessionId", async (req: Request, res: Response) => {
  const friendId = parseIntParam(String(req.params.friendId), "friendId")
  const sessionId = parseIntParam(String(req.params.sessionId), "sessionId")

  if (!(await areFriends(req.user!.id, friendId)))
    throw new ForbiddenError("Can only view sessions of friends")
  if (!(await hasPermission(friendId, req.user!.id, "history")))
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
  if (!invite || new Date(invite.expires_at) < new Date())
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

  await updateParticipantProgress(jointSessionId, req.user!.id, {
    exerciseIndex: exerciseIndex ?? null,
    setIndex: setIndex ?? null,
    exerciseName: exerciseName ?? null,
    readyForNext: readyForNext || false,
    exerciseNames: exerciseNames ?? null,
  })

  const session = await getJointSession(jointSessionId)
  if (session) {
    notifyJointProgress(session, req.user!.id, {
      exerciseIndex,
      setIndex,
      exerciseName,
      readyForNext,
      exerciseNames,
    })
  }

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

  if (!(await areFriends(req.user!.id, friendId)))
    throw new ForbiddenError("Not friends")
  if (!(await hasPermission(friendId, req.user!.id, "watch_session")))
    throw new ForbiddenError("Friend hasn't granted you watch session access")

  const status = await getUserActiveSessionStatus(friendId)
  if (!status.hasActiveSession) throw new NotFoundError("Active session")

  res.json({ success: true, session: { sessionId: status.sessionId } })
})

router.get("/watch/friend/:friendId/session/:sessionId/live", async (req: Request, res: Response) => {
  const friendId = parseIntParam(String(req.params.friendId), "friendId")
  const sessionId = parseIntParam(String(req.params.sessionId), "sessionId")

  if (!(await areFriends(req.user!.id, friendId)))
    throw new ForbiddenError("Not friends")
  if (!(await hasPermission(friendId, req.user!.id, "watch_session")))
    throw new ForbiddenError("No watch permission")

  const status = await getUserActiveSessionStatus(friendId)
  if (!status.hasActiveSession || status.sessionId !== sessionId)
    throw new NotFoundError("Active session")

  const session = await getFriendSessionDetails(friendId, sessionId)
  if (!session) throw new NotFoundError("Session")

  res.json({ success: true, liveSession: session })
})

export default router
