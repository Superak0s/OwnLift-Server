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
  setMacrosGoals,
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
    entry,
  })
})

router.get("/log", async (req: Request, res: Response) => {
  const days = queryLimit(req, { def: 30, max: 365, key: "days" })
  const entries = await getMacrosHistory(req.user!.id, days)
  res.json({ success: true, entries })
})

router.put("/goals", async (req: Request, res: Response) => {
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
})

router.delete("/log/:id", async (req: Request, res: Response) => {
  const entryId = parseIntParam(String(req.params.id), "macro entry ID")
  const deleted = await deleteMacrosEntry(req.user!.id, entryId)
  if (!deleted) throw new NotFoundError("Macro entry")
  res.json({ success: true, message: "Entry deleted successfully" })
})

export default router
