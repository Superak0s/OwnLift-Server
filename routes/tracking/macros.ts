// routes/tracking/macros.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import {
  asyncHandler,
  ValidationError,
  NotFoundError,
} from "../../middleware/errorHandler.js"
import {
  logMacrosIntake,
  getMacrosHistory,
  getMacrosStatsForDate,
  setMacrosGoals,
  getMacrosGoals,
  deleteMacrosEntry,
  getWeeklySummary,
  getMonthlySummary,
} from "../../models/tracking/macros.js"

const router: Router = Router()

router.use(authenticateToken)

// Validates a macro gram value — must be a finite positive number under 9999
function safeMacro(v: unknown, name: string): number | null {
  if (v == null) return null
  const n = parseFloat(v as string)
  if (isNaN(n) || !isFinite(n) || n < 0 || n > 9999) {
    throw new ValidationError(`Invalid ${name} value`)
  }
  return n
}

/**
 * POST /api/tracking/macros/log
 */
router.post(
  "/log",
  asyncHandler(async (req: Request, res: Response) => {
    const {
      name,
      protein,
      carbs,
      fat,
      calories,
      errorMargin = 0,
      time,
      takenAt,
      note,
    } = req.body
    const userId = req.user!.id

    if (!time || !takenAt) {
      throw new ValidationError("time and takenAt are required")
    }

    const hasAtLeastOne =
      protein != null ||
      carbs != null ||
      fat != null ||
      calories != null ||
      name
    if (!hasAtLeastOne) {
      throw new ValidationError(
        "Provide at least a name or one macro value (protein, carbs, fat, calories)",
      )
    }

    const parsedProtein = safeMacro(protein, "protein")
    const parsedCarbs = safeMacro(carbs, "carbs")
    const parsedFat = safeMacro(fat, "fat")
    const parsedCalories = safeMacro(calories, "calories")
    const parsedMargin = safeMacro(errorMargin, "errorMargin") ?? 0

    const entry = await logMacrosIntake(
      userId,
      name,
      parsedProtein,
      parsedCarbs,
      parsedFat,
      parsedCalories,
      parsedMargin,
      time,
      takenAt,
      note,
    )

    res.json({
      success: true,
      entry: {
        id: entry.id,
        name: entry.name,
        protein: entry.protein,
        carbs: entry.carbs,
        fat: entry.fat,
        calories: entry.calories,
        errorMargin: entry.error_margin,
        time: entry.time,
        takenAt: entry.taken_at,
        note: entry.note,
      },
    })
  }),
)

/**
 * GET /api/tracking/macros/log
 */
router.get(
  "/log",
  asyncHandler(async (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query.days as string) || 30, 365)
    const entries = await getMacrosHistory(req.user!.id, days)
    res.json({ success: true, entries })
  }),
)

/**
 * GET /api/tracking/macros/stats/:date
 */
router.get(
  "/stats/:date",
  asyncHandler(async (req: Request, res: Response) => {
    const stats = await getMacrosStatsForDate(req.user!.id, req.params.date)
    res.json({ success: true, stats })
  }),
)

/**
 * PUT /api/tracking/macros/goals
 */
router.put(
  "/goals",
  asyncHandler(async (req: Request, res: Response) => {
    const { protein, carbs, fat, calories } = req.body

    if (protein == null && carbs == null && fat == null && calories == null) {
      throw new ValidationError("Provide at least one goal to update")
    }

    const parsedProtein = safeMacro(protein, "protein")
    const parsedCarbs = safeMacro(carbs, "carbs")
    const parsedFat = safeMacro(fat, "fat")
    const parsedCalories = safeMacro(calories, "calories")

    await setMacrosGoals(req.user!.id, {
      protein: parsedProtein ?? undefined,
      carbs: parsedCarbs ?? undefined,
      fat: parsedFat ?? undefined,
      calories: parsedCalories ?? undefined,
    })

    res.json({ success: true, goals: { protein, carbs, fat, calories } })
  }),
)

/**
 * GET /api/tracking/macros/goals
 */
router.get(
  "/goals",
  asyncHandler(async (req: Request, res: Response) => {
    const goals = await getMacrosGoals(req.user!.id)
    res.json({ success: true, goals })
  }),
)

/**
 * DELETE /api/tracking/macros/log/:id
 */
router.delete(
  "/log/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const deleted = await deleteMacrosEntry(
      req.user!.id,
      parseInt(req.params.id),
    )
    if (!deleted) throw new NotFoundError("Macro entry")
    res.json({ success: true, message: "Entry deleted successfully" })
  }),
)

/**
 * GET /api/tracking/macros/summary/week
 */
router.get(
  "/summary/week",
  asyncHandler(async (req: Request, res: Response) => {
    const summary = await getWeeklySummary(req.user!.id)
    res.json({ success: true, summary })
  }),
)

/**
 * GET /api/tracking/macros/summary/month
 */
router.get(
  "/summary/month",
  asyncHandler(async (req: Request, res: Response) => {
    const result = await getMonthlySummary(req.user!.id)
    res.json({
      success: true,
      summary: result.summary,
      averageDaily: result.averageDaily,
    })
  }),
)

export default router
