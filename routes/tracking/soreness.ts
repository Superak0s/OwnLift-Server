// routes/tracking/soreness.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import {
  asyncHandler,
  ValidationError,
} from "../../middleware/errorHandler.js"
import {
  logSoreness,
  getSorenessHistory,
  getSorenessForDate,
  getSorenessMap,
  getSorenessStats,
  deleteSorenessEntry,
  getValidMuscleGroups,
} from "../../models/tracking/soreness.js"

const router: Router = Router()

router.use(authenticateToken)

// ─── Log soreness ────────────────────────────────────────────────────────────

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { muscleGroup, intensity, loggedAt, note } = req.body

    if (!muscleGroup || !intensity) {
      throw new ValidationError("Muscle group and intensity are required")
    }

    if (!Number.isInteger(intensity) || intensity < 1 || intensity > 10) {
      throw new ValidationError("Intensity must be an integer from 1-10")
    }

    const id = await logSoreness(
      req.user!.id,
      muscleGroup,
      intensity,
      loggedAt || null,
      note || null,
    )
    res.status(201).json({ success: true, id })
  }),
)

// ─── Get soreness history ────────────────────────────────────────────────────

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(String(req.query.limit)) : 100
    const history = await getSorenessHistory(req.user!.id, limit)
    res.json({ success: true, data: history })
  }),
)

// ─── Get soreness for specific date ────────────────────────────────────────

router.get(
  "/date/:date",
  asyncHandler(async (req: Request, res: Response) => {
    const date = String(req.params.date)
    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ValidationError("Date must be in YYYY-MM-DD format")
    }
    const entries = await getSorenessForDate(req.user!.id, date)
    res.json({ success: true, data: entries })
  }),
)

// ─── Get soreness map (visual representation) ──────────────────────────────

// Get soreness map for today (latest entries)
router.get(
  "/map",
  asyncHandler(async (req: Request, res: Response) => {
    const map = await getSorenessMap(req.user!.id)
    res.json({ success: true, data: map })
  }),
)

// Get soreness map for specific date
router.get(
  "/map/:date",
  asyncHandler(async (req: Request, res: Response) => {
    const date = String(req.params.date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ValidationError("Date must be in YYYY-MM-DD format")
    }
    const map = await getSorenessMap(req.user!.id, date)
    res.json({ success: true, data: map })
  }),
)

// ─── Get soreness stats ────────────────────────────────────────────────────

router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const days = req.query.days ? parseInt(String(req.query.days)) : 7
    const stats = await getSorenessStats(req.user!.id, days)
    res.json({ success: true, data: stats })
  }),
)

// ─── Get valid muscle groups ──────────────────────────────────────────────

router.get(
  "/muscles/list",
  asyncHandler(async (req: Request, res: Response) => {
    const muscles = getValidMuscleGroups()
    res.json({ success: true, data: muscles })
  }),
)

// ─── Delete soreness entry ────────────────────────────────────────────────

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id))
    if (isNaN(id)) throw new ValidationError("Invalid soreness entry ID")
    const deleted = await deleteSorenessEntry(req.user!.id, id)
    if (!deleted) throw new ValidationError("Soreness entry not found")
    res.json({ success: true })
  }),
)

export default router
