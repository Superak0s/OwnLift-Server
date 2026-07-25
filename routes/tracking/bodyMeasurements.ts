// routes/tracking/bodyMeasurements.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import {
  asyncHandler,
  ValidationError,
} from "../../middleware/errorHandler.js"
import {
  logMeasurement,
  getMeasurementHistory,
  getLatestMeasurement,
  getMeasurementStats,
  deleteMeasurementEntry,
} from "../../models/tracking/bodyMeasurements.js"

const router: Router = Router()

router.use(authenticateToken)

// ─── Log measurement ──────────────────────────────────────────────────────────

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { waistCm, armLeftCm, armRightCm, chestCm, measuredAt, note } =
      req.body

    if (!waistCm && !armLeftCm && !armRightCm && !chestCm) {
      throw new ValidationError(
        "At least one measurement (waist, arms, or chest) is required",
      )
    }

    const id = await logMeasurement(
      req.user!.id,
      waistCm || null,
      armLeftCm || null,
      armRightCm || null,
      chestCm || null,
      measuredAt || null,
      note || null,
    )
    res.status(201).json({ success: true, id })
  }),
)

// ─── Get measurement history ──────────────────────────────────────────────────

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(String(req.query.limit)) : 90
    const history = await getMeasurementHistory(req.user!.id, limit)
    res.json({ success: true, data: history })
  }),
)

// ─── Get latest measurement ───────────────────────────────────────────────────

router.get(
  "/latest",
  asyncHandler(async (req: Request, res: Response) => {
    const latest = await getLatestMeasurement(req.user!.id)
    res.json({ success: true, data: latest })
  }),
)

// ─── Get measurement stats ────────────────────────────────────────────────────

router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const days = req.query.days ? parseInt(String(req.query.days)) : 90
    const stats = await getMeasurementStats(req.user!.id, days)
    res.json({ success: true, data: stats })
  }),
)

// ─── Delete measurement ───────────────────────────────────────────────────────

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id)
    if (isNaN(id)) throw new ValidationError("Invalid measurement ID")
    const deleted = await deleteMeasurementEntry(req.user!.id, id)
    if (!deleted) throw new ValidationError("Measurement not found")
    res.json({ success: true })
  }),
)

export default router
