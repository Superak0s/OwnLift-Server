import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import {
  NotFoundError,
  ValidationError,
} from "@/middleware/errorHandler.js"
import {
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  removeFriend,
  getFriends,
  getPendingRequests,
  getSentRequests,
  searchUsers,
  blockUser,
  unblockUser,
  getBlockedUsers,
  reportUser,
  REPORT_REASONS,
  type ReportReason,
} from "./friends.model.js"
import { findUserById, findUserByUsername } from "@/features/auth/auth.model.js"
import { queryLimit, parseIntParam } from "@/middleware/validation.js"

const router: Router = Router()

router.use(authenticateToken)

router.get("/search", async (req: Request, res: Response) => {
  const { q } = req.query

  if (!q || (q as string).trim().length < 2) {
    throw new ValidationError("Search term must be at least 2 characters")
  }

  const users = await searchUsers(
    (q as string).trim(),
    req.user!.id,
    queryLimit(req, { def: 10, max: 50 }),
  )

  res.json({ success: true, users })
})

router.get("/", async (req: Request, res: Response) => {
  const friends = await getFriends(req.user!.id)
  res.json({ success: true, friends })
})

router.get("/requests/pending", async (req: Request, res: Response) => {
  const requests = await getPendingRequests(req.user!.id)
  res.json({ success: true, requests })
})

router.get("/requests/sent", async (req: Request, res: Response) => {
  const requests = await getSentRequests(req.user!.id)
  res.json({ success: true, requests })
})

router.post("/request", async (req: Request, res: Response) => {
  const { username } = req.body

  if (typeof username !== "string" || !username) {
    throw new ValidationError("Username is required")
  }

  // Cheap self-request check before any DB round-trip
  if (username === req.user!.username) {
    throw new ValidationError("Cannot send friend request to yourself")
  }

  const targetUser = await findUserByUsername(username)

  if (!targetUser) {
    throw new NotFoundError("User")
  }

  // Belt-and-suspenders ID check (handles username case-sensitivity edge cases)
  if (targetUser.id === req.user!.id) {
    throw new ValidationError("Cannot send friend request to yourself")
  }

  const friendshipId = await sendFriendRequest(req.user!.id, targetUser.id)

  const { sendToUser } = await import("@/ws/wsServer.js")
  sendToUser(targetUser.id, "friend_request_received", {
    friendshipId,
    fromUserId: req.user!.id,
    fromUsername: req.user!.username,
  })

  res.status(201).json({
    success: true,
    message: "Friend request sent",
    friendshipId,
  })
})

router.post("/request/:friendshipId/accept", async (req: Request, res: Response) => {
  const friendshipId = parseIntParam(String(req.params.friendshipId), "friendship ID")

  await acceptFriendRequest(req.user!.id, friendshipId)
  res.json({ success: true, message: "Friend request accepted" })
})

// Also the cancel route: the recipient rejects, the sender cancels, and both
// are the same pending row being deleted by someone in the pair.
router.post("/request/:friendshipId/reject", async (req: Request, res: Response) => {
  const friendshipId = parseIntParam(String(req.params.friendshipId), "friendship ID")

  await rejectFriendRequest(req.user!.id, friendshipId)
  res.json({ success: true, message: "Friend request rejected" })
})

// NOTE the addressing: this one takes a USER id, while the accept/reject
// routes above take a FRIENDSHIP id. Two schemes in one router, kept because
// the app addresses an unfriend by the person, not by the row.
router.delete("/:friendId", async (req: Request, res: Response) => {
  const friendId = parseIntParam(String(req.params.friendId), "friend ID")

  await removeFriend(req.user!.id, friendId)
  res.json({ success: true, message: "Friend removed" })
})

router.get("/blocked", async (req: Request, res: Response) => {
  const blocked = await getBlockedUsers(req.user!.id)
  res.json({ success: true, blocked })
})

/**
 * POST /api/friends/block/:userId
 *
 * Blocking also removes the friendship and every sharing permission between
 * the two accounts (see blockUser), so it is not reversible by unblocking —
 * the pair have to re-add each other afterwards.
 */
router.post("/block/:userId", async (req: Request, res: Response) => {
  const userId = parseIntParam(String(req.params.userId), "user ID")

  const target = await findUserById(userId)
  if (!target) throw new NotFoundError("User")

  await blockUser(req.user!.id, userId)
  res.json({ success: true, message: "User blocked" })
})

router.delete("/block/:userId", async (req: Request, res: Response) => {
  const userId = parseIntParam(String(req.params.userId), "user ID")

  if (!(await unblockUser(req.user!.id, userId))) {
    throw new NotFoundError("Block")
  }
  res.json({ success: true, message: "User unblocked" })
})

/**
 * POST /api/friends/report
 *
 * Body: { userId, reason, details? }. Reports are stored for this instance's
 * operator to review (`pnpm ownlift reports`); a self-hosted deployment has
 * no central moderation team to forward them to.
 */
router.post("/report", async (req: Request, res: Response) => {
  const { userId, reason, details } = req.body

  const targetId = parseIntParam(String(userId), "user ID")

  if (!REPORT_REASONS.includes(reason)) {
    throw new ValidationError(
      `reason must be one of: ${REPORT_REASONS.join(", ")}`,
    )
  }

  if (details !== undefined && typeof details !== "string") {
    throw new ValidationError("details must be a string")
  }

  if (!(await findUserById(targetId))) throw new NotFoundError("User")

  const reportId = await reportUser(
    req.user!.id,
    targetId,
    reason as ReportReason,
    details,
  )

  res.status(201).json({
    success: true,
    message: "Report submitted",
    reportId,
  })
})

export default router
