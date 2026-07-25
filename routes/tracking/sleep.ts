// routes/tracking/sleep.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth"
import {
  asyncHandler,
  ValidationError,
} from "../../middleware/errorHandler"
import {
  logSleep,
  getSleepHistory,
  getSleepStats,
  deleteSleepEntry,
  type SleepQuality,
} from "../../models/tracking/sleep"

const router: Router = Router()

router.use(authenticateToken)

// ─── Log sleep ────────────────────────────────────────────────────────────────

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { bedtime, wakeTime, quality, note } = req.body

    if (!bedtime || !wakeTime) {
      throw new ValidationError("Bedtime and wake time are required")
    }

    const qualityValue =
      quality || "good"
    if (!["poor", "fair", "good", "excellent"].includes(qualityValue)) {
      throw new ValidationError(
        "Quality must be: poor, fair, good, or excellent",
      )
    }

    const id = await logSleep(
      req.user!.id,
      bedtime,
      wakeTime,
      qualityValue as SleepQuality,
      note || null,
    )
    res.status(201).json({ success: true, id })
  }),
)

// ─── Get sleep history ────────────────────────────────────────────────────────

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(String(req.query.limit)) : 90
    const history = await getSleepHistory(req.user!.id, limit)
    res.json({ success: true, data: history })
  }),
)

// ─── Get sleep stats ──────────────────────────────────────────────────────────

router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const days = req.query.days ? parseInt(String(req.query.days)) : 30
    const stats = await getSleepStats(req.user!.id, days)
    res.json({ success: true, data: stats })
  }),
)

// ─── Delete sleep entry ───────────────────────────────────────────────────────

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id)
    if (isNaN(id)) throw new ValidationError("Invalid sleep entry ID")
    const deleted = await deleteSleepEntry(req.user!.id, id)
    if (!deleted) throw new ValidationError("Sleep entry not found")
    res.json({ success: true })
  }),
)

export default router
