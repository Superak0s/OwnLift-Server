// routes/tracking/hydration.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import {
  asyncHandler,
  ValidationError,
} from "../../middleware/errorHandler.js"
import {
  logHydration,
  getHydrationHistory,
  getDailyHydration,
  getHydrationStats,
  deleteHydrationEntry,
  getHydrationSettings,
  setHydrationSettings,
} from "../../models/tracking/hydration.js"

const router: Router = Router()

router.use(authenticateToken)

// ─── Log hydration ────────────────────────────────────────────────────────────

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { amountMl, loggedAt, note } = req.body

    if (!amountMl || amountMl <= 0) {
      throw new ValidationError("Amount in ml is required and must be > 0")
    }

    const id = await logHydration(
      req.user!.id,
      amountMl,
      loggedAt || null,
      note || null,
    )
    res.status(201).json({ success: true, id })
  }),
)

// ─── Get hydration history ────────────────────────────────────────────────────

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(String(req.query.limit)) : 100
    const history = await getHydrationHistory(req.user!.id, limit)
    res.json({ success: true, data: history })
  }),
)

// ─── Get daily hydration ──────────────────────────────────────────────────────

router.get(
  "/daily/:date",
  asyncHandler(async (req: Request, res: Response) => {
    const { date } = req.params
    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ValidationError("Date must be in YYYY-MM-DD format")
    }
    const daily = await getDailyHydration(req.user!.id, date)
    res.json({ success: true, data: daily })
  }),
)

// ─── Get hydration stats ──────────────────────────────────────────────────────

router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const stats = await getHydrationStats(req.user!.id)
    res.json({ success: true, data: stats })
  }),
)

// ─── Hydration settings (goal ml, measurement error %) ────────────────────────
router.get(
  "/settings",
  asyncHandler(async (req: Request, res: Response) => {
    const s = await getHydrationSettings(req.user!.id)
    res.json({ success: true, data: s })
  }),
)

router.post(
  "/settings",
  asyncHandler(async (req: Request, res: Response) => {
    const { goalMl, measurementErrorPercent } = req.body
    if (goalMl != null && (!Number.isInteger(goalMl) || goalMl <= 0)) {
      throw new ValidationError("goalMl must be a positive integer")
    }
    if (measurementErrorPercent != null && typeof measurementErrorPercent !== "number") {
      throw new ValidationError("measurementErrorPercent must be a number (percentage)")
    }
    await setHydrationSettings(req.user!.id, { goalMl, measurementErrorPercent })
    res.json({ success: true })
  }),
)

// ─── Delete hydration entry ───────────────────────────────────────────────────

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id)
    if (isNaN(id)) throw new ValidationError("Invalid hydration entry ID")
    const deleted = await deleteHydrationEntry(req.user!.id, id)
    if (!deleted) throw new ValidationError("Hydration entry not found")
    res.json({ success: true })
  }),
)

export default router
