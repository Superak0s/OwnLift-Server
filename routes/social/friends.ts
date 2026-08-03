// routes/social/friends.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import {
  asyncHandler,
  NotFoundError,
  ValidationError,
  ConflictError,
  ForbiddenError,
} from "../../middleware/errorHandler.js"
import {
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  removeFriend,
  getFriends,
  getPendingRequests,
  getSentRequests,
  searchUsers,
  findFriendSuggestionsByEmailHashes,
} from "../../models/social/friends.js"
import { findUserById, findUserByUsername } from "../../models/auth.js"

const router: Router = Router()

router.use(authenticateToken)

/**
 * GET /api/friends/search
 */
router.get(
  "/search",
  asyncHandler(async (req: Request, res: Response) => {
    const { q, limit } = req.query

    if (!q || (q as string).trim().length < 2) {
      throw new ValidationError("Search term must be at least 2 characters")
    }

    const users = await searchUsers(
      (q as string).trim(),
      req.user!.id,
      limit ? Math.min(parseInt(limit as string) || 10, 50) : 10,
    )

    res.json({ success: true, users, count: users.length })
  }),
)

/**
 * GET /api/friends
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const friends = await getFriends(req.user!.id)
    res.json({ success: true, friends, count: friends.length })
  }),
)

/**
 * GET /api/friends/requests/pending
 */
router.get(
  "/requests/pending",
  asyncHandler(async (req: Request, res: Response) => {
    const requests = await getPendingRequests(req.user!.id)
    res.json({ success: true, requests, count: requests.length })
  }),
)

/**
 * GET /api/friends/requests/sent
 */
router.get(
  "/requests/sent",
  asyncHandler(async (req: Request, res: Response) => {
    const requests = await getSentRequests(req.user!.id)
    res.json({ success: true, requests, count: requests.length })
  }),
)

/**
 * POST /api/friends/suggest-from-contacts
 *
 * Body: { emailHashes: string[] } — SHA-256 hex digests of the caller's
 * phone contacts' emails, hashed client-side. We only ever compare hashes
 * here; raw emails from the contact list never reach the server.
 */
router.post(
  "/suggest-from-contacts",
  asyncHandler(async (req: Request, res: Response) => {
    const { emailHashes } = req.body

    if (!Array.isArray(emailHashes)) {
      throw new ValidationError("emailHashes must be an array")
    }

    if (emailHashes.length === 0) {
      res.json({ success: true, suggestions: [], count: 0 })
      return
    }

    if (emailHashes.length > 2000) {
      throw new ValidationError("Too many contacts submitted (max 2000)")
    }

    const isValidHash = (h: unknown): h is string =>
      typeof h === "string" && /^[a-f0-9]{64}$/i.test(h)

    if (!emailHashes.every(isValidHash)) {
      throw new ValidationError(
        "emailHashes must be SHA-256 hex digests (64 hex characters each)",
      )
    }

    const suggestions = await findFriendSuggestionsByEmailHashes(
      req.user!.id,
      emailHashes,
    )

    res.json({ success: true, suggestions, count: suggestions.length })
  }),
)

/**
 * POST /api/friends/request
 */
router.post(
  "/request",
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.body

    if (!username) {
      throw new ValidationError("Username is required")
    }

    // Cheap self-request check before any DB round-trip
    if (username === req.user!.username) {
      throw new ValidationError("Cannot send friend request to yourself")
    }

    // Use a dedicated model function — no dynamic import needed
    const targetUser = await findUserByUsername(username)

    if (!targetUser) {
      throw new NotFoundError("User")
    }

    // Belt-and-suspenders ID check (handles username case-sensitivity edge cases)
    if (targetUser.id === req.user!.id) {
      throw new ValidationError("Cannot send friend request to yourself")
    }

    let friendshipId: number
    try {
      friendshipId = await sendFriendRequest(req.user!.id, targetUser.id)
    } catch (err) {
      const msg = (err as Error).message
      if (
        msg === "Friend request already pending" ||
        msg === "Already friends"
      ) {
        throw new ConflictError(msg)
      }
      throw err
    }

    const { notifyFriendRequest } = await import("../../ws/wsServer.js")
    notifyFriendRequest(targetUser.id, {
      friendshipId,
      fromUserId: req.user!.id,
      fromUsername: req.user!.username,
    })

    res.status(201).json({
      success: true,
      message: "Friend request sent",
      friendship_id: friendshipId,
      to_user: {
        id: targetUser.id,
        username: targetUser.username,
        name: targetUser.name,
      },
    })
  }),
)

/**
 * POST /api/friends/request/:friendshipId/accept
 */
router.post(
  "/request/:friendshipId/accept",
  asyncHandler(async (req: Request, res: Response) => {
    const friendshipId = parseInt(String(req.params.friendshipId), 10)
    if (isNaN(friendshipId)) throw new ValidationError("Invalid friendship ID")

    try {
      await acceptFriendRequest(req.user!.id, friendshipId)
    } catch (err) {
      if ((err as Error).message === "Friend request not found")
        throw new NotFoundError("Friend request")
      throw err
    }
    res.json({ success: true, message: "Friend request accepted" })
  }),
)

/**
 * POST /api/friends/request/:friendshipId/reject
 */
router.post(
  "/request/:friendshipId/reject",
  asyncHandler(async (req: Request, res: Response) => {
    const friendshipId = parseInt(String(req.params.friendshipId), 10)
    if (isNaN(friendshipId)) throw new ValidationError("Invalid friendship ID")

    try {
      await rejectFriendRequest(req.user!.id, friendshipId)
    } catch (err) {
      if ((err as Error).message === "Friend request not found")
        throw new NotFoundError("Friend request")
      throw err
    }
    res.json({ success: true, message: "Friend request rejected" })
  }),
)

/**
 * DELETE /api/friends/:friendId
 */
router.delete(
  "/:friendId",
  asyncHandler(async (req: Request, res: Response) => {
    const friendId = parseInt(String(req.params.friendId), 10)
    if (isNaN(friendId)) throw new ValidationError("Invalid friend ID")

    try {
      await removeFriend(req.user!.id, friendId)
    } catch (err) {
      if ((err as Error).message === "Friendship not found")
        throw new NotFoundError("Friendship")
      throw err
    }
    res.json({ success: true, message: "Friend removed" })
  }),
)

export default router
