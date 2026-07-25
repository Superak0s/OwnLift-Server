// routes/tracking/menstrual.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import {
  asyncHandler,
  ValidationError,
} from "../../middleware/errorHandler.js"
import {
  logMenstrualCycle,
  endMenstrualCycle,
  getMenstrualHistory,
  getLastMenstrualCycle,
  getCycleStats,
  deleteMenstrualEntry,
  getMenstrualSettings,
  setMenstrualSettings,
  type FlowIntensity,
} from "../../models/tracking/menstrual.js"
import {
  setDayFlow,
  getDayFlowForDate,
  deleteDayFlowForDate,
} from "../../models/tracking/menstrualDayFlow.js"

const router: Router = Router()

router.use(authenticateToken)

// ─── Log menstrual cycle start ────────────────────────────────────────────────

// Primary route used by client: POST /api/tracking/menstrual
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { cycleStart, flowIntensity, symptoms } = req.body

    if (!cycleStart) {
      throw new ValidationError("Cycle start date is required")
    }

    const intensity = flowIntensity || "moderate"
    if (!["light", "moderate", "heavy"].includes(intensity)) {
      throw new ValidationError("Flow intensity must be: light, moderate, or heavy")
    }

    const id = await logMenstrualCycle(
      req.user!.id,
      cycleStart,
      intensity as FlowIntensity,
      symptoms || null,
    )
    res.status(201).json({ success: true, id })
  }),
)

// Backwards-compatible route (existing /cycle)
router.post(
  "/cycle",
  asyncHandler(async (req: Request, res: Response) => {
    const { cycleStart, flowIntensity, symptoms } = req.body

    if (!cycleStart) {
      throw new ValidationError("Cycle start date is required")
    }

    const intensity = flowIntensity || "moderate"
    if (!["light", "moderate", "heavy"].includes(intensity)) {
      throw new ValidationError("Flow intensity must be: light, moderate, or heavy")
    }

    const id = await logMenstrualCycle(
      req.user!.id,
      cycleStart,
      intensity as FlowIntensity,
      symptoms || null,
    )
    res.status(201).json({ success: true, id })
  }),
)

// ─── End menstrual cycle ──────────────────────────────────────────────────────

// Client expects PUT /api/tracking/menstrual/:id/end
router.put(
  "/:id/end",
  asyncHandler(async (req: Request, res: Response) => {
    const cycleId = parseInt(req.params.id)
    const { cycleEnd } = req.body

    if (isNaN(cycleId)) throw new ValidationError("Invalid cycle ID")
    if (!cycleEnd) throw new ValidationError("Cycle end date is required")

    const updated = await endMenstrualCycle(req.user!.id, cycleId, cycleEnd)
    if (!updated) throw new ValidationError("Cycle not found")
    res.json({ success: true })
  }),
)

// Backwards-compatible POST /cycle/:id/end
router.post(
  "/cycle/:id/end",
  asyncHandler(async (req: Request, res: Response) => {
    const cycleId = parseInt(req.params.id)
    const { cycleEnd } = req.body

    if (isNaN(cycleId)) throw new ValidationError("Invalid cycle ID")
    if (!cycleEnd) throw new ValidationError("Cycle end date is required")

    const updated = await endMenstrualCycle(req.user!.id, cycleId, cycleEnd)
    if (!updated) throw new ValidationError("Cycle not found")
    res.json({ success: true })
  }),
)

// ─── Get menstrual history ────────────────────────────────────────────────────

// Client expects GET /api/tracking/menstrual?limit=N
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(String(req.query.limit)) : 12
    const history = await getMenstrualHistory(req.user!.id, limit)
    res.json({ success: true, data: history })
  }),
)

// Backwards-compatible /history
router.get(
  "/history",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(String(req.query.limit)) : 12
    const history = await getMenstrualHistory(req.user!.id, limit)
    res.json({ success: true, data: history })
  }),
)

// ─── Get last menstrual cycle ─────────────────────────────────────────────────

// Client expects GET /api/tracking/menstrual/last
router.get(
  "/last",
  asyncHandler(async (req: Request, res: Response) => {
    const cycle = await getLastMenstrualCycle(req.user!.id)
    res.json({ success: true, data: cycle })
  }),
)

// Backwards-compatible /current
router.get(
  "/current",
  asyncHandler(async (req: Request, res: Response) => {
    const cycle = await getLastMenstrualCycle(req.user!.id)
    res.json({ success: true, data: cycle })
  }),
)

// ─── Get cycle stats and prediction ───────────────────────────────────────────

router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const stats = await getCycleStats(req.user!.id)
    res.json({ success: true, data: stats })
  }),
)

// ─── Delete menstrual entry ───────────────────────────────────────────────────

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id)
    if (isNaN(id)) throw new ValidationError("Invalid menstrual entry ID")
    const result = await deleteMenstrualEntry(req.user!.id, id)
    if (!result.deleted) throw new ValidationError("Menstrual entry not found")
    // If this entry was a cycle start, client should remove predicted periods
    res.json({ success: true, removedPredictions: result.wasCycleStart })
  }),
)

// ─── Menstrual settings (period days, cycle length) ─────────────────────────────

router.get(
  "/settings",
  asyncHandler(async (req: Request, res: Response) => {
    const settings = await getMenstrualSettings(req.user!.id)
    res.json({ success: true, data: settings })
  }),
)

router.post(
  "/settings",
  asyncHandler(async (req: Request, res: Response) => {
    const { periodDays, cycleLengthDays } = req.body
    if (periodDays != null && (!Number.isInteger(periodDays) || periodDays <= 0)) {
      throw new ValidationError("periodDays must be a positive integer")
    }
    if (cycleLengthDays != null && (!Number.isInteger(cycleLengthDays) || cycleLengthDays <= 0)) {
      throw new ValidationError("cycleLengthDays must be a positive integer")
    }
    await setMenstrualSettings(req.user!.id, { periodDays, cycleLengthDays })
    res.json({ success: true })
  }),
)

// ─── Per-day flow intensity (menstrual_day_flow) ─────────────────────────────
// POST /api/tracking/menstrual/day-flow  { date: 'YYYY-MM-DD', intensity: 'light'|'moderate'|'heavy', note?: string }
router.post(
  "/day-flow",
  asyncHandler(async (req: Request, res: Response) => {
    const { date, intensity, note } = req.body
    if (!date) throw new ValidationError("date is required")
    await setDayFlow(req.user!.id, date, intensity || "moderate", note || null)
    res.status(201).json({ success: true })
  }),
)

// GET /api/tracking/menstrual/day-flow?date=YYYY-MM-DD
router.get(
  "/day-flow",
  asyncHandler(async (req: Request, res: Response) => {
    const date = req.query.date ? String(req.query.date) : null
    if (!date) throw new ValidationError("date query parameter is required")
    const entry = await getDayFlowForDate(req.user!.id, date)
    res.json({ success: true, data: entry })
  }),
)

// DELETE /api/tracking/menstrual/day-flow?date=YYYY-MM-DD
router.delete(
  "/day-flow",
  asyncHandler(async (req: Request, res: Response) => {
    const date = req.query.date ? String(req.query.date) : null
    if (!date) throw new ValidationError("date query parameter is required")
    const deleted = await deleteDayFlowForDate(req.user!.id, date)
    res.json({ success: true, deleted })
  }),
)

export default router
