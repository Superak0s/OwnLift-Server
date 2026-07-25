// routes/auth.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../middleware/auth.js"
import {
  asyncHandler,
  ConflictError,
  UnauthorizedError,
  ValidationError,
} from "../middleware/errorHandler.js"
import {
  validateRegistration,
  validateLogin,
  validateRequired,
} from "../middleware/validation.js"
import {
  createUser,
  findUserByCredentials,
  findUserById,
  verifyPassword,
  generateToken,
  usernameExists,
  emailExists,
  changePassword,
} from "../models/auth.js"
import { updateUserProfile, deleteAllUserData } from "../models/user.js"
import { issueWsTicket } from "../ws/wsServer.js"

const router: Router = Router()

/**
 * POST /api/auth/signup
 */
router.post(
  "/signup",
  validateRegistration,
  asyncHandler(async (req: Request, res: Response) => {
    const { username, email, password, name } = req.body

    if (await usernameExists(username)) {
      throw new ConflictError("Username already taken")
    }
    if (await emailExists(email)) {
      throw new ConflictError("Email already registered")
    }

    const userId = await createUser(username, email, password, name)
    const token = generateToken(userId)
    const user = await findUserById(userId)

    if (!user) throw new Error("Failed to create user")

    res.status(201).json({
      success: true,
      message: "Account created successfully",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        is_admin: user.is_admin,
        created_at: user.created_at,
      },
    })
  }),
)

/**
 * POST /api/auth/signin
 */
router.post(
  "/signin",
  validateLogin,
  asyncHandler(async (req: Request, res: Response) => {
    const { username, password } = req.body

    const user = await findUserByCredentials(username)
    if (!user) throw new UnauthorizedError("Invalid credentials")

    const isValid = await verifyPassword(password, user.password_hash!)
    if (!isValid) throw new UnauthorizedError("Invalid credentials")

    const token = generateToken(user.id)

    res.json({
      success: true,
      message: "Signed in successfully",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        is_admin: user.is_admin,
        created_at: user.created_at,
      },
    })
  }),
)

/**
 * GET /api/auth/me
 */
router.get(
  "/me",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, user: req.user })
  }),
)

/**
 * PUT /api/auth/profile
 */
router.put(
  "/profile",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const { name, email } = req.body
    const updates: Record<string, string> = {}

    if (name !== undefined) updates.name = name

    if (email !== undefined) {
      // Single DB call: check if that email belongs to a *different* user
      if (await emailExists(email)) {
        const existingUser = await findUserByCredentials(email)
        if (!existingUser || existingUser.id !== req.user!.id) {
          throw new ConflictError("Email already in use")
        }
      }
      updates.email = email
    }

    if (Object.keys(updates).length === 0) {
      return res.json({
        success: true,
        message: "No changes provided",
        user: req.user,
      })
    }

    await updateUserProfile(req.user!.id, updates)
    const user = await findUserById(req.user!.id)

    res.json({ success: true, message: "Profile updated successfully", user })
  }),
)

/**
 * PUT /api/auth/password
 */
router.put(
  "/password",
  authenticateToken,
  validateRequired(["currentPassword", "newPassword"]),
  asyncHandler(async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body

    if (newPassword.length < 8) {
      throw new ValidationError("New password must be at least 8 characters")
    }

    const user = await findUserByCredentials(req.user!.username)
    if (!user) throw new UnauthorizedError("User not found")

    const isValid = await verifyPassword(currentPassword, user.password_hash!)
    if (!isValid) throw new UnauthorizedError("Current password is incorrect")

    await changePassword(req.user!.id, newPassword)

    res.json({ success: true, message: "Password changed successfully" })
  }),
)

/**
 * DELETE /api/auth/account/data
 *
 * Wipes ALL of the authenticated user's data (workouts, tracking, social)
 * while keeping the account itself. Requires an explicit confirmation token
 * so it can't be triggered accidentally.
 */
router.delete(
  "/account/data",
  authenticateToken,
  validateRequired(["confirmDelete"]),
  asyncHandler(async (req: Request, res: Response) => {
    if (req.body.confirmDelete !== "DELETE_ALL_DATA") {
      throw new ValidationError(
        'Must confirm deletion with confirmDelete: "DELETE_ALL_DATA"',
      )
    }

    await deleteAllUserData(req.user!.id)

    res.json({ success: true, message: "All data deleted successfully" })
  }),
)

/**
 * POST /api/auth/ws-ticket
 *
 * Issues a short-lived, single-use ticket that the client presents in the
 * WebSocket handshake URL (?ticket=...) instead of the long-lived JWT.
 * This keeps the JWT out of server logs and HTTP proxy access logs.
 */
router.post(
  "/ws-ticket",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const ticket = issueWsTicket(req.user!.id)
    res.json({ success: true, ticket })
  }),
)

/**
 * POST /api/auth/refresh
 *
 * Reissues a fresh JWT for the currently authenticated user. Requires the
 * existing token to still be valid (authenticateToken rejects expired
 * tokens), so this only extends a live session proactively — it does not
 * revive one that has already expired. If you need to refresh sessions
 * *after* expiry, you'd need a separate, longer-lived refresh token stored
 * server-side (e.g. in a `refresh_tokens` table), since a single JWT can't
 * authenticate itself once it's expired.
 */
router.post(
  "/refresh",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const token = generateToken(req.user!.id)
    res.json({ success: true, token })
  }),
)

export default router
