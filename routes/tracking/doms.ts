// routes/tracking/doms.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import {
  asyncHandler,
  ValidationError,
} from "../../middleware/errorHandler.js"
import {
  logSoreness,
  getActiveSoreness,
  updateSorenessWithFollowUp,
  batchFollowUp,
  getHistoryByMuscle,
  getDOMSStats,
  getSorenessMap,
  getSorenessByDateRange,
} from "../../models/tracking/doms.js"

const router: Router = Router()

router.use(authenticateToken)

// ─── Log soreness ────────────────────────────────────────────────────────────

/**
 * POST /api/tracking/doms/log
 */
router.post(
  "/log",
  asyncHandler(async (req: Request, res: Response) => {
    const { muscleGroup, intensity, notes } = req.body

    if (!muscleGroup || intensity === undefined || intensity === null) {
      throw new ValidationError("Muscle group and intensity are required")
    }

    const result = await logSoreness(
      req.user!.id,
      muscleGroup,
      intensity,
      notes || null,
    )
    res.status(201).json({ success: true, data: result })
  }),
)

// ─── Get active soreness ─────────────────────────────────────────────────────

/**
 * GET /api/tracking/doms/active
 */
router.get(
  "/active",
  asyncHandler(async (req: Request, res: Response) => {
    const records = await getActiveSoreness(req.user!.id)
    res.json({ success: true, data: records })
  }),
)

// ─── Update soreness with follow-up ──────────────────────────────────────────

/**
 * PUT /api/tracking/doms/:id/followup
 */
router.put(
  "/:id/followup",
  asyncHandler(async (req: Request, res: Response) => {
    const sorenessId = parseInt(String(req.params.id))
    if (isNaN(sorenessId)) throw new ValidationError("Invalid soreness ID")

    const { intensity, status, notes } = req.body

    if (intensity === undefined || intensity === null) {
      throw new ValidationError("Intensity is required")
    }
    if (!["still_sore", "better", "recovered"].includes(status)) {
      throw new ValidationError(
        "Status must be 'still_sore', 'better', or 'recovered'",
      )
    }

    const result = await updateSorenessWithFollowUp(
      req.user!.id,
      sorenessId,
      intensity,
      status,
      notes || null,
    )
    res.json({ success: true, data: result })
  }),
)

// ─── Batch follow-up ─────────────────────────────────────────────────────────

/**
 * POST /api/tracking/doms/batch-followup
 */
router.post(
  "/batch-followup",
  asyncHandler(async (req: Request, res: Response) => {
    const { updates } = req.body

    if (!Array.isArray(updates) || updates.length === 0) {
      throw new ValidationError("Updates array is required and must not be empty")
    }

    const results = await batchFollowUp(req.user!.id, updates)
    res.json({ success: true, data: results })
  }),
)

// ─── History by muscle ───────────────────────────────────────────────────────

/**
 * GET /api/tracking/doms/history/:muscle
 */
router.get(
  "/history/:muscle",
  asyncHandler(async (req: Request, res: Response) => {
    const muscle = String(req.params.muscle)
    const records = await getHistoryByMuscle(req.user!.id, muscle)
    res.json({ success: true, data: records })
  }),
)

// ─── Stats ────────────────────────────────────────────────────────────────────

/**
 * GET /api/tracking/doms/stats?days=N
 */
router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const days = req.query.days ? parseInt(String(req.query.days)) : 30
    const stats = await getDOMSStats(req.user!.id, days)
    res.json({ success: true, data: stats })
  }),
)

// ─── Soreness map ─────────────────────────────────────────────────────────────

/**
 * GET /api/tracking/doms/map
 */
router.get(
  "/map",
  asyncHandler(async (req: Request, res: Response) => {
    const map = await getSorenessMap(req.user!.id)
    res.json({ success: true, data: map })
  }),
)

// ─── Date range ───────────────────────────────────────────────────────────────

/**
 * GET /api/tracking/doms/range?start=YYYY-MM-DD&end=YYYY-MM-DD
 */
router.get(
  "/range",
  asyncHandler(async (req: Request, res: Response) => {
    const startDate = req.query.start as string
    const endDate = req.query.end as string

    if (!startDate || !endDate) {
      throw new ValidationError("Both 'start' and 'end' query params are required")
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      throw new ValidationError("Start date must be in YYYY-MM-DD format")
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      throw new ValidationError("End date must be in YYYY-MM-DD format")
    }

    const records = await getSorenessByDateRange(req.user!.id, startDate, endDate)
    res.json({ success: true, data: records })
  }),
)

export default router
