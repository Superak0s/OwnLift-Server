// src/routes/tracking/supplements.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import {
  asyncHandler,
  ValidationError,
  NotFoundError,
} from "../../middleware/errorHandler.js"
import {
  createSupplement,
  getSupplementById,
  listSupplements,
  listSupplementSummaries,
  updateSupplement,
  deleteSupplement,
  logSupplement,
  hasTakenTodayServer,
  getHistory,
  getStreak,
  deleteLogEntry,
  saveLocation,
  getLocation,
  toggleLocation,
  checkIfAtLocation,
  deleteLocation,
} from "../../models/tracking/supplements.js"

const router: Router = Router()
router.use(authenticateToken)

// ─── Validation helpers ───────────────────────────────────────────────────────

const VALID_TIME = /^\d{1,2}:\d{2}$/
const VALID_HEX_COLOR = /^#[0-9A-Fa-f]{6}$/

function validateReminderTime(t: unknown): void {
  if (t != null && (typeof t !== "string" || !VALID_TIME.test(t))) {
    throw new ValidationError("reminderTime must be in HH:MM format")
  }
}

function validateColor(c: unknown): void {
  if (c != null && (typeof c !== "string" || !VALID_HEX_COLOR.test(c))) {
    throw new ValidationError("color must be a hex color string (e.g. #FF5733)")
  }
}

function parseSupplementId(raw: string): number {
  const id = parseInt(raw, 10)
  if (isNaN(id)) throw new ValidationError("Invalid supplement id")
  return id
}

async function requireSupplement(userId: number, supplementId: number) {
  const s = await getSupplementById(userId, supplementId)
  if (!s) throw new NotFoundError("Supplement")
  return s
}

// ─── Supplement CRUD ──────────────────────────────────────────────────────────

/**
 * GET /api/tracking/supplements
 * Returns all supplements for the user, each enriched with takenToday + streak.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const summaries = await listSupplementSummaries(req.user!.id)
    res.json({ success: true, supplements: summaries })
  }),
)

/**
 * POST /api/tracking/supplements
 * Create a new supplement definition.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const {
      name,
      unit = "g",
      defaultAmount,
      reminderEnabled = false,
      reminderTime = null,
      color = null,
      icon = null,
    } = req.body

    if (!name || typeof name !== "string" || !name.trim()) {
      throw new ValidationError("name is required")
    }
    if (name.trim().length > 100) {
      throw new ValidationError("name must be 100 characters or fewer")
    }
    if (typeof unit !== "string" || !unit.trim() || unit.length > 30) {
      throw new ValidationError(
        "unit must be a non-empty string (max 30 chars)",
      )
    }
    if (
      defaultAmount !== undefined &&
      (typeof defaultAmount !== "number" ||
        defaultAmount <= 0 ||
        defaultAmount > 10000)
    ) {
      throw new ValidationError(
        "defaultAmount must be a positive number (max 10000)",
      )
    }
    validateReminderTime(reminderTime)
    validateColor(color)

    const supplement = await createSupplement(
      req.user!.id,
      name.trim(),
      unit.trim(),
      defaultAmount ?? 5,
      reminderEnabled,
      reminderTime,
      color,
      icon ?? null,
    )

    res.status(201).json({ success: true, supplement })
  }),
)

/**
 * GET /api/tracking/supplements/:id
 */
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const supplementId = parseSupplementId(String(req.params.id))
    const supplement = await requireSupplement(req.user!.id, supplementId)
    const [takenToday, streak] = await Promise.all([
      hasTakenTodayServer(req.user!.id, supplementId),
      getStreak(req.user!.id, supplementId),
    ])
    res.json({
      success: true,
      supplement,
      takenToday: !!takenToday,
      todayEntry: takenToday,
      streak,
    })
  }),
)

/**
 * PATCH /api/tracking/supplements/:id
 * Partial update — only provided fields are changed.
 */
router.patch(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const supplementId = parseSupplementId(String(req.params.id))
    await requireSupplement(req.user!.id, supplementId)

    const {
      name,
      unit,
      defaultAmount,
      reminderEnabled,
      reminderTime,
      locationReminderEnabled,
      color,
      icon,
    } = req.body

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim())
        throw new ValidationError("name must be a non-empty string")
      if (name.trim().length > 100)
        throw new ValidationError("name must be 100 characters or fewer")
    }
    if (
      unit !== undefined &&
      (typeof unit !== "string" || !unit.trim() || unit.length > 30)
    ) {
      throw new ValidationError(
        "unit must be a non-empty string (max 30 chars)",
      )
    }
    if (
      defaultAmount !== undefined &&
      (typeof defaultAmount !== "number" ||
        defaultAmount <= 0 ||
        defaultAmount > 10000)
    ) {
      throw new ValidationError(
        "defaultAmount must be a positive number (max 10000)",
      )
    }
    validateReminderTime(reminderTime)
    validateColor(color)

    const updated = await updateSupplement(req.user!.id, supplementId, {
      name: name?.trim(),
      unit: unit?.trim(),
      defaultAmount,
      reminderEnabled,
      reminderTime,
      locationReminderEnabled,
      color,
      icon,
    })

    res.json({ success: true, supplement: updated })
  }),
)

/**
 * DELETE /api/tracking/supplements/:id
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const supplementId = parseSupplementId(String(req.params.id))
    const deleted = await deleteSupplement(req.user!.id, supplementId)
    if (!deleted) throw new NotFoundError("Supplement")
    res.json({ success: true })
  }),
)

// ─── Log ──────────────────────────────────────────────────────────────────────

/**
 * POST /api/tracking/supplements/:id/log
 */
router.post(
  "/:id/log",
  asyncHandler(async (req: Request, res: Response) => {
    const supplementId = parseSupplementId(String(req.params.id))
    const supplement = await requireSupplement(req.user!.id, supplementId)
    const { amount, takenAt, note } = req.body

    if (
      amount !== undefined &&
      (typeof amount !== "number" || amount <= 0 || amount > 10000)
    ) {
      throw new ValidationError("amount must be a positive number (max 10000)")
    }

    const entryId = await logSupplement(
      req.user!.id,
      supplementId,
      amount ?? supplement.defaultAmount,
      takenAt ?? null,
      note ?? null,
    )
    const streak = await getStreak(req.user!.id, supplementId)

    res.status(201).json({ success: true, id: entryId, streak })
  }),
)

/**
 * GET /api/tracking/supplements/:id/log
 */
router.get(
  "/:id/log",
  asyncHandler(async (req: Request, res: Response) => {
    const supplementId = parseSupplementId(String(req.params.id))
    await requireSupplement(req.user!.id, supplementId)

    const limit = Math.min(parseInt(req.query.limit as string) || 30, 365)
    const [entries, streak, todayEntry] = await Promise.all([
      getHistory(req.user!.id, supplementId, limit),
      getStreak(req.user!.id, supplementId),
      hasTakenTodayServer(req.user!.id, supplementId),
    ])

    res.json({
      success: true,
      entries,
      streak,
      takenToday: !!todayEntry,
      todayEntry,
    })
  }),
)

/**
 * DELETE /api/tracking/supplements/:id/log/:entryId
 */
router.delete(
  "/:id/log/:entryId",
  asyncHandler(async (req: Request, res: Response) => {
    const supplementId = parseSupplementId(String(req.params.id))
    await requireSupplement(req.user!.id, supplementId)

    const entryId = parseInt(String(req.params.entryId), 10)
    if (isNaN(entryId)) throw new ValidationError("Invalid entry id")

    const deleted = await deleteLogEntry(req.user!.id, entryId)
    if (!deleted) throw new NotFoundError("Log entry")
    res.json({ success: true })
  }),
)

/**
 * GET /api/tracking/supplements/:id/streak
 */
router.get(
  "/:id/streak",
  asyncHandler(async (req: Request, res: Response) => {
    const supplementId = parseSupplementId(String(req.params.id))
    await requireSupplement(req.user!.id, supplementId)
    const streak = await getStreak(req.user!.id, supplementId)
    res.json({ success: true, streak })
  }),
)

// ─── Location ─────────────────────────────────────────────────────────────────

/**
 * PUT /api/tracking/supplements/:id/location
 */
router.put(
  "/:id/location",
  asyncHandler(async (req: Request, res: Response) => {
    const supplementId = parseSupplementId(String(req.params.id))
    await requireSupplement(req.user!.id, supplementId)

    const { latitude, longitude, address, radius } = req.body
    if (latitude == null || longitude == null || !address || radius == null) {
      throw new ValidationError(
        "latitude, longitude, address, and radius are required",
      )
    }
    if (
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new ValidationError("Invalid coordinates")
    }
    if (radius < 50 || radius > 1000) {
      throw new ValidationError("radius must be between 50 and 1000 meters")
    }

    const location = await saveLocation(
      req.user!.id,
      supplementId,
      latitude,
      longitude,
      address,
      radius,
    )
    res.json({ success: true, location })
  }),
)

/**
 * GET /api/tracking/supplements/:id/location
 */
router.get(
  "/:id/location",
  asyncHandler(async (req: Request, res: Response) => {
    const supplementId = parseSupplementId(String(req.params.id))
    await requireSupplement(req.user!.id, supplementId)
    const location = await getLocation(req.user!.id, supplementId)
    res.json({ success: true, location, enabled: location?.enabled ?? false })
  }),
)

/**
 * PUT /api/tracking/supplements/:id/location/toggle
 */
router.put(
  "/:id/location/toggle",
  asyncHandler(async (req: Request, res: Response) => {
    const supplementId = parseSupplementId(String(req.params.id))
    await requireSupplement(req.user!.id, supplementId)

    const { enabled } = req.body
    if (typeof enabled !== "boolean") {
      throw new ValidationError("enabled must be a boolean")
    }

    try {
      const location = await toggleLocation(req.user!.id, supplementId, enabled)
      res.json({ success: true, enabled: location.enabled })
    } catch (err) {
      if ((err as Error).message === "No reminder location set") {
        throw new NotFoundError("Reminder location")
      }
      throw err
    }
  }),
)

/**
 * POST /api/tracking/supplements/:id/location/check
 */
router.post(
  "/:id/location/check",
  asyncHandler(async (req: Request, res: Response) => {
    const supplementId = parseSupplementId(String(req.params.id))
    await requireSupplement(req.user!.id, supplementId)

    const { latitude, longitude } = req.body
    if (latitude == null || longitude == null) {
      throw new ValidationError("latitude and longitude are required")
    }
    if (
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new ValidationError("Invalid coordinates")
    }

    const result = await checkIfAtLocation(
      req.user!.id,
      supplementId,
      latitude,
      longitude,
    )
    res.json({ success: true, ...result })
  }),
)

/**
 * DELETE /api/tracking/supplements/:id/location
 */
router.delete(
  "/:id/location",
  asyncHandler(async (req: Request, res: Response) => {
    const supplementId = parseSupplementId(String(req.params.id))
    await requireSupplement(req.user!.id, supplementId)

    const deleted = await deleteLocation(req.user!.id, supplementId)
    if (!deleted) throw new NotFoundError("Reminder location")
    res.json({
      success: true,
      message: "Reminder location deleted successfully",
    })
  }),
)

export default router
