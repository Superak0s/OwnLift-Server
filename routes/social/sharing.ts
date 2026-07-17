// routes/social/sharing.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth"
import {
  asyncHandler,
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from "../../middleware/errorHandler"
import { query as dbQuery } from "../../config/database"
import {
  notifyJointInvite,
  notifyInviteStatus,
  notifyJointProgress,
} from "../../ws/wsServer"
import {
  grantPermission,
  revokePermission,
  getGrantedPermissions,
  getReceivedPermissions,
  hasPermission,
  getFriendSessions,
  getFriendSessionDetails,
  getFriendAnalytics,
  getSharingStats,
  createJointInvite,
  getInvite,
  getPendingInviteForUser,
  acceptInvite,
  declineInvite,
  getJointSession,
  updateParticipantProgress,
  endJointSession,
  getUserActiveSessionStatus,
} from "../../models/social/sharing"
import { areFriends } from "../../models/social/friends"

const router: Router = Router()

router.use(authenticateToken)

// Max size for a shared program payload stored in sharing_permissions.payload
const MAX_PROGRAM_PAYLOAD_BYTES = 512 * 1024 // 512 KB

/** Parse a route param as a positive integer or throw a 400. */
function parseIntParam(value: string, name: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 1) throw new ValidationError(`Invalid ${name}`)
  return n
}

// ─── Permissions ──────────────────────────────────────────────────────────────

router.post(
  "/permissions",
  asyncHandler(async (req: Request, res: Response) => {
    const { friendId, permissionType, payload } = req.body

    if (!friendId) throw new ValidationError("friendId is required")
    if (!permissionType) throw new ValidationError("permissionType is required")

    if (permissionType === "program") {
      if (!payload?.programData) {
        throw new ValidationError(
          "payload.programData is required for program permission",
        )
      }
      // Guard against storing arbitrarily large program blobs
      const payloadSize = Buffer.byteLength(JSON.stringify(payload), "utf8")
      if (payloadSize > MAX_PROGRAM_PAYLOAD_BYTES) {
        throw new ValidationError(
          `Program payload exceeds the ${MAX_PROGRAM_PAYLOAD_BYTES / 1024} KB limit`,
        )
      }
    }

    const parsedFriendId = parseIntParam(String(friendId), "friendId")

    if (!(await areFriends(req.user!.id, parsedFriendId))) {
      throw new ForbiddenError("Can only grant permissions to friends")
    }

    let permissionId: number
    try {
      permissionId = await grantPermission(
        req.user!.id,
        parsedFriendId,
        permissionType,
        payload ?? null,
      )
    } catch (err) {
      if ((err as Error).message.startsWith("Invalid permission type"))
        throw new ValidationError((err as Error).message)
      throw err
    }

    res
      .status(201)
      .json({ success: true, message: "Permission granted", permissionId })
  }),
)

router.get(
  "/permissions/granted",
  asyncHandler(async (req: Request, res: Response) => {
    const permissions = await getGrantedPermissions(req.user!.id)
    res.json({ success: true, permissions, count: permissions.length })
  }),
)

router.get(
  "/permissions/received",
  asyncHandler(async (req: Request, res: Response) => {
    const permissions = await getReceivedPermissions(req.user!.id)
    res.json({ success: true, permissions, count: permissions.length })
  }),
)

router.delete(
  "/permissions/:permissionId",
  asyncHandler(async (req: Request, res: Response) => {
    const permissionId = parseIntParam(req.params.permissionId, "permissionId")
    try {
      await revokePermission(req.user!.id, permissionId)
    } catch (err) {
      if ((err as Error).message === "Permission not found or not owned by you")
        throw new NotFoundError("Permission")
      throw err
    }
    res.json({ success: true, message: "Permission revoked" })
  }),
)

// ─── Friend sessions ──────────────────────────────────────────────────────────

router.get(
  "/sessions/friend/:friendId",
  asyncHandler(async (req: Request, res: Response) => {
    const friendId = parseIntParam(req.params.friendId, "friendId")
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 60, 200)

    if (!(await areFriends(req.user!.id, friendId)))
      throw new ForbiddenError("Can only view sessions of friends")
    if (!(await hasPermission(friendId, req.user!.id, "history")))
      throw new ForbiddenError("Friend hasn't granted you history access")

    const sessions = await getFriendSessions(friendId, limit)
    res.json({ success: true, sessions, count: sessions.length })
  }),
)

router.get(
  "/sessions/friend/:friendId/:sessionId",
  asyncHandler(async (req: Request, res: Response) => {
    const friendId = parseIntParam(req.params.friendId, "friendId")
    const sessionId = parseIntParam(req.params.sessionId, "sessionId")

    if (!(await areFriends(req.user!.id, friendId)))
      throw new ForbiddenError("Can only view sessions of friends")
    if (!(await hasPermission(friendId, req.user!.id, "history")))
      throw new ForbiddenError("Friend hasn't granted you history access")

    const session = await getFriendSessionDetails(friendId, sessionId)
    if (!session) throw new NotFoundError("Session")

    res.json({ success: true, session })
  }),
)

// ─── Analytics ────────────────────────────────────────────────────────────────

router.get(
  "/analytics/received",
  asyncHandler(async (req: Request, res: Response) => {
    const permissions = await getReceivedPermissions(req.user!.id)
    const shares = permissions
      .filter((p: any) => p.permission_type === "analytics")
      .map((p: any) => ({
        id: p.id,
        senderId: p.from_user_id,
        senderUsername: p.from_username,
        sharedAt: p.created_at,
        message: p.payload?.message ?? null,
      }))
    res.json({ success: true, shares, count: shares.length })
  }),
)

router.get(
  "/analytics/sent",
  asyncHandler(async (req: Request, res: Response) => {
    const permissions = await getGrantedPermissions(req.user!.id)
    const shares = permissions
      .filter((p: any) => p.permission_type === "analytics")
      .map((p: any) => ({
        id: p.id,
        receiverId: p.to_user_id,
        receiverUsername: p.to_username,
        sharedAt: p.created_at,
        message: p.payload?.message ?? null,
      }))
    res.json({ success: true, shares, count: shares.length })
  }),
)

router.get(
  "/analytics/friend/:friendId",
  asyncHandler(async (req: Request, res: Response) => {
    const friendId = parseIntParam(req.params.friendId, "friendId")

    if (!(await areFriends(req.user!.id, friendId)))
      throw new ForbiddenError("Can only view analytics of friends")
    if (!(await hasPermission(friendId, req.user!.id, "analytics")))
      throw new ForbiddenError("Friend hasn't granted you analytics access")

    const analytics = await getFriendAnalytics(friendId)
    res.json({ success: true, analytics })
  }),
)

// ─── Program sharing ──────────────────────────────────────────────────────────

router.get(
  "/program/received",
  asyncHandler(async (req: Request, res: Response) => {
    const permissions = await getReceivedPermissions(req.user!.id)
    const programs = permissions
      .filter(
        (p: any) => p.permission_type === "program" && p.payload?.programData,
      )
      .map((p: any) => ({
        id: p.id,
        senderId: p.from_user_id,
        senderUsername: p.from_username,
        sharedAt: p.created_at,
        message: p.payload?.message ?? null,
        programData: p.payload.programData,
      }))
    res.json({ success: true, programs, count: programs.length })
  }),
)

router.get(
  "/program/sent",
  asyncHandler(async (req: Request, res: Response) => {
    const permissions = await getGrantedPermissions(req.user!.id)
    const programs = permissions
      .filter(
        (p: any) => p.permission_type === "program" && p.payload?.programData,
      )
      .map((p: any) => ({
        id: p.id,
        receiverId: p.to_user_id,
        receiverUsername: p.to_username,
        sharedAt: p.created_at,
        message: p.payload?.message ?? null,
        programData: p.payload.programData,
      }))
    res.json({ success: true, programs, count: programs.length })
  }),
)

// ─── Stats ────────────────────────────────────────────────────────────────────

router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const stats = await getSharingStats(req.user!.id)
    res.json({ success: true, stats })
  }),
)

// ─── Joint sessions ───────────────────────────────────────────────────────────

router.get(
  "/joint-sessions/friend/:friendId/status",
  asyncHandler(async (req: Request, res: Response) => {
    const friendId = parseIntParam(req.params.friendId, "friendId")

    if (!(await areFriends(req.user!.id, friendId)))
      throw new ForbiddenError("Not friends")

    const status = await getUserActiveSessionStatus(friendId)
    res.json({ success: true, ...status })
  }),
)

router.post(
  "/joint-sessions/invite",
  asyncHandler(async (req: Request, res: Response) => {
    const { toUserId, fromSessionId } = req.body

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
      fromSessionId ?? myStatus.sessionId,
    )

    notifyJointInvite(parsedToUserId, {
      inviteId,
      fromUserId: req.user!.id,
      fromUsername: req.user!.username,
      fromSessionId: fromSessionId ?? myStatus.sessionId,
    })

    res.status(201).json({ success: true, inviteId })
  }),
)

router.get(
  "/joint-sessions/invites/pending",
  asyncHandler(async (req: Request, res: Response) => {
    const invite = await getPendingInviteForUser(req.user!.id)
    if (!invite) throw new NotFoundError("Pending invite")

    res.json({
      success: true,
      inviteId: invite.id,
      fromUserId: invite.from_user_id,
      fromUsername: invite.from_username,
      fromSessionId: invite.from_session_id,
      expiresAt: invite.expires_at,
    })
  }),
)

router.get(
  "/joint-sessions/invites/:inviteId",
  asyncHandler(async (req: Request, res: Response) => {
    const inviteId = parseIntParam(req.params.inviteId, "inviteId")
    const invite = await getInvite(inviteId)
    if (!invite) throw new NotFoundError("Invite")
    if (
      invite.from_user_id !== req.user!.id &&
      invite.to_user_id !== req.user!.id
    ) {
      throw new ForbiddenError("Unauthorized")
    }

    // Enforce expiry server-side (don't rely only on DB-level expiry)
    if (
      invite.status === "pending" &&
      new Date(invite.expires_at) < new Date()
    ) {
      throw new NotFoundError("Invite")
    }

    const payload: Record<string, unknown> = {
      success: true,
      status: invite.status,
    }

    if (invite.status === "accepted") {
      const [rows] = await dbQuery<any[]>(
        `SELECT js.id FROM joint_sessions js
         JOIN joint_session_participants p1 ON p1.joint_session_id = js.id AND p1.user_id = ?
         JOIN joint_session_participants p2 ON p2.joint_session_id = js.id AND p2.user_id = ?
         WHERE js.status = 'active' ORDER BY js.created_at DESC LIMIT 1`,
        [invite.from_user_id, invite.to_user_id],
      )
      if (rows.length > 0)
        payload.jointSession = await getJointSession(rows[0].id)
    }

    res.json(payload)
  }),
)

router.post(
  "/joint-sessions/invites/:inviteId/accept",
  asyncHandler(async (req: Request, res: Response) => {
    const inviteId = parseIntParam(req.params.inviteId, "inviteId")

    // Pre-flight: check invite hasn't expired
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

    let jointSessionId: number
    try {
      ;({ jointSessionId } = await acceptInvite(
        inviteId,
        req.user!.id,
        myStatus.sessionId,
      ))
    } catch (err) {
      if (
        (err as Error).message === "Invite not found, already used, or expired"
      )
        throw new NotFoundError("Invite")
      throw err
    }

    const jointSession = await getJointSession(jointSessionId)
    if (!jointSession) throw new Error("Joint session not found after accept")

    const sender = jointSession.participants.find(
      (p: any) => p.userId !== req.user!.id,
    )
    if (sender) notifyInviteStatus(sender.userId, "accepted", jointSession)

    res.json({ success: true, jointSession })
  }),
)

router.post(
  "/joint-sessions/invites/:inviteId/decline",
  asyncHandler(async (req: Request, res: Response) => {
    const inviteId = parseIntParam(req.params.inviteId, "inviteId")
    const invite = await getInvite(inviteId)

    try {
      await declineInvite(inviteId, req.user!.id)
    } catch (err) {
      if ((err as Error).message === "Invite not found or already resolved")
        throw new NotFoundError("Invite")
      throw err
    }

    if (invite) notifyInviteStatus(invite.from_user_id, "declined")
    res.json({ success: true, message: "Invite declined" })
  }),
)

router.get(
  "/joint-sessions/:jointSessionId",
  asyncHandler(async (req: Request, res: Response) => {
    const jointSessionId = parseIntParam(
      req.params.jointSessionId,
      "jointSessionId",
    )
    const session = await getJointSession(jointSessionId)
    if (!session) throw new NotFoundError("Joint session")
    if (!session.participants.some((p: any) => p.userId === req.user!.id))
      throw new ForbiddenError("Unauthorized")

    res.json({ success: true, jointSession: session })
  }),
)

router.patch(
  "/joint-sessions/:jointSessionId/progress",
  asyncHandler(async (req: Request, res: Response) => {
    const {
      exerciseIndex,
      setIndex,
      exerciseName,
      readyForNext,
      selectedPerson,
      exerciseNames,
    } = req.body
    const jointSessionId = parseIntParam(
      req.params.jointSessionId,
      "jointSessionId",
    )

    try {
      await updateParticipantProgress(jointSessionId, req.user!.id, {
        exerciseIndex: exerciseIndex ?? null,
        setIndex: setIndex ?? null,
        exerciseName: exerciseName ?? null,
        readyForNext: readyForNext || false,
        selectedPerson: selectedPerson ?? null,
        exerciseNames: exerciseNames ?? null,
      })
    } catch (err) {
      if (
        (err as Error).message === "Participant not found in this joint session"
      )
        throw new NotFoundError("Participant")
      throw err
    }

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
  }),
)

router.delete(
  "/joint-sessions/:jointSessionId/leave",
  asyncHandler(async (req: Request, res: Response) => {
    const jointSessionId = parseIntParam(
      req.params.jointSessionId,
      "jointSessionId",
    )
    const session = await getJointSession(jointSessionId)

    try {
      await endJointSession(jointSessionId, req.user!.id)
    } catch (err) {
      if ((err as Error).message === "Not a participant of this session")
        throw new ForbiddenError("Not a participant of this session")
      throw err
    }

    if (session) {
      const partner = session.participants.find(
        (p: any) => p.userId !== req.user!.id,
      )
      if (partner) notifyInviteStatus(partner.userId, "session_ended")
    }

    res.json({ success: true, message: "Left joint session" })
  }),
)

// ─── Watch session ────────────────────────────────────────────────────────────

router.get(
  "/watch/friend/:friendId/active",
  asyncHandler(async (req: Request, res: Response) => {
    const friendId = parseIntParam(req.params.friendId, "friendId")

    if (!(await areFriends(req.user!.id, friendId)))
      throw new ForbiddenError("Not friends")
    if (!(await hasPermission(friendId, req.user!.id, "watch_session")))
      throw new ForbiddenError("Friend hasn't granted you watch session access")

    const status = await getUserActiveSessionStatus(friendId)
    if (!status.hasActiveSession) throw new NotFoundError("Active session")

    res.json({ success: true, session: { sessionId: status.sessionId } })
  }),
)

router.get(
  "/watch/friend/:friendId/session/:sessionId/live",
  asyncHandler(async (req: Request, res: Response) => {
    const friendId = parseIntParam(req.params.friendId, "friendId")
    const sessionId = parseIntParam(req.params.sessionId, "sessionId")

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
  }),
)

export default router
