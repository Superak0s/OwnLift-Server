import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "@/middleware/errorHandler.js"
import {
  validateRegistration,
  validateLogin,
  validateRequired,
  validateProfileUpdate,
  validatePasswordChange,
} from "@/middleware/validation.js"
import {
  createUser,
  findUserByCredentials,
  findUserById,
  verifyPassword,
  getDummyPasswordHash,
  generateToken,
  getTokenVersion,
  deleteUserAccount,
  changePassword,
} from "./auth.model.js"
import {
  updateUserProfile,
  deleteAllUserData,
  exportUserData,
} from "./user.model.js"

const router: Router = Router()

router.post("/signup", validateRegistration, async (req: Request, res: Response) => {
  const { username, email, password, name } = req.body
  const userId = await createUser(username, email, password, name)
  const token = generateToken(userId, 0)
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
      isAdmin: user.isAdmin,
      createdAt: user.createdAt,
    },
  })
})

router.post("/signin", validateLogin, async (req: Request, res: Response) => {
  const { username, password } = req.body

  // Always run bcrypt, even when the username doesn't exist, so the response
  // time doesn't reveal which accounts are real. The !user check still gates
  // the outcome, so a password that happens to match the dummy hash is not a
  // way in.
  const user = await findUserByCredentials(username)
  const isValid = await verifyPassword(
    password,
    user?.password_hash ?? getDummyPasswordHash(),
  )
  if (!user || !isValid) throw new UnauthorizedError("Invalid credentials")

  const token = generateToken(user.id, await getTokenVersion(user.id))

  res.json({
    success: true,
    message: "Signed in successfully",
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      isAdmin: user.isAdmin,
      createdAt: user.createdAt,
    },
  })
})

router.get("/me", authenticateToken, async (req: Request, res: Response) => {
  res.json({ success: true, user: req.user })
})

router.put("/profile", authenticateToken, validateProfileUpdate, async (req: Request, res: Response) => {
  const { name, email, heightCm } = req.body
  const updates: Record<string, string | number> = {}

  if (name !== undefined) updates.name = name

  if (email !== undefined) updates.email = email

  // The app keeps height on-device; this is the only way it reaches the
  // server, where the body-fat entry records the height it was measured at.
  if (heightCm !== undefined) updates.height_cm = Number(heightCm)

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
})

/**
 * DELETE /api/auth/account/data
 *
 * Wipes ALL of the authenticated user's data (workouts, tracking, social)
 * while keeping the account itself. Requires an explicit confirmation token
 * so it can't be triggered accidentally.
 */
router.delete("/account/data", authenticateToken, validateRequired(["confirmDelete"]), async (req: Request, res: Response) => {
  if (req.body.confirmDelete !== "DELETE_ALL_DATA") {
    throw new ValidationError(
      'Must confirm deletion with confirmDelete: "DELETE_ALL_DATA"',
    )
  }

  await deleteAllUserData(req.user!.id)

  res.json({ success: true, message: "All data deleted successfully" })
})

/**
 * DELETE /api/auth/account
 *
 * Permanently deletes the account and everything it owns. Re-checks the
 * password because a stolen phone already has a valid token, and this is
 * the one action nothing can undo.
 */
router.delete("/account", authenticateToken, validateRequired(["password"]), async (req: Request, res: Response) => {
  if (!(await deleteUserAccount(req.user!.id, req.body.password))) {
    // 403, not 401: the app treats every 401 as an expired session.
    throw new ForbiddenError("Incorrect password")
  }
  res.json({ success: true, message: "Account deleted successfully" })
})

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
router.post("/refresh", authenticateToken, async (req: Request, res: Response) => {
  const token = generateToken(
    req.user!.id,
    await getTokenVersion(req.user!.id),
  )
  res.json({ success: true, token })
})

/**
 * PUT /api/auth/password
 *
 * changePassword bumps token_version, which invalidates every outstanding
 * JWT — including the caller's. We hand back a freshly minted one so the
 * device that made the change stays signed in and every other device is
 * signed out, which is the point of changing a password.
 */
router.put("/password", authenticateToken, validatePasswordChange, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body

  const user = await findUserByCredentials(req.user!.username)
  if (!user || !(await verifyPassword(currentPassword, user.password_hash!))) {
    // 403, not 401: the app treats every 401 as an expired session.
    throw new ForbiddenError("Incorrect password")
  }

  await changePassword(req.user!.id, newPassword)

  res.json({
    success: true,
    message: "Password changed successfully",
    token: generateToken(req.user!.id, await getTokenVersion(req.user!.id)),
  })
})

/**
 * GET /api/auth/account/export
 *
 * Everything this server holds about the caller, as JSON. Progress photo
 * bytes are omitted (metadata only) — see exportUserData.
 */
router.get("/account/export", authenticateToken, async (req: Request, res: Response) => {
  res.json({ success: true, data: await exportUserData(req.user!.id) })
})

export default router
