import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { queryLimit, parseIntParam } from "@/middleware/validation.js"
import {
  ValidationError,
  NotFoundError,
} from "@/middleware/errorHandler.js"
import {
  logMacrosIntake,
  getMacrosHistory,
  deleteMacrosEntry,
} from "./macros.model.js"

const router: Router = Router()

router.use(authenticateToken)

function safeMacro(v: unknown, name: string): number | null {
  if (v == null) return null
  const n = parseFloat(v as string)
  if (isNaN(n) || !isFinite(n) || n < 0 || n > 9999) {
    throw new ValidationError(`Invalid ${name} value`)
  }
  return n
}

router.post("/log", async (req: Request, res: Response) => {
  const {
    name,
    protein,
    carbs,
    fat,
    calories,
    errorMargin = 0,
    takenAt,
    note,
  } = req.body
  const userId = req.user!.id

  if (!takenAt) throw new ValidationError("takenAt is required")

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
    takenAt,
    note,
  )

  res.json({
    success: true,
    entry,
  })
})

router.get("/log", async (req: Request, res: Response) => {
  const days = queryLimit(req, { def: 30, max: 365, key: "days" })
  const entries = await getMacrosHistory(req.user!.id, days)
  res.json({ success: true, entries })
})

// Macro goals live in /api/settings with every other preference — there is no
// PUT /goals here any more.

router.delete("/log/:id", async (req: Request, res: Response) => {
  const entryId = parseIntParam(String(req.params.id), "macro entry ID")
  const deleted = await deleteMacrosEntry(req.user!.id, entryId)
  if (!deleted) throw new NotFoundError("Macro entry")
  res.json({ success: true, message: "Entry deleted successfully" })
})

export default router
