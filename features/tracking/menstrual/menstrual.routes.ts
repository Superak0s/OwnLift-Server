import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import {
  logMenstrualCycle,
  getMenstrualHistory,
  getCycleStats,
  deleteMenstrualEntry,
  getMenstrualSettings,
  setMenstrualSettings,
} from "./menstrual.model.js"
import { queryLimit, parseIntParam } from "@/middleware/validation.js"

const router: Router = Router()

router.use(authenticateToken)

router.post("/", async (req: Request, res: Response) => {
  const { cycleStart, symptoms } = req.body

  if (!cycleStart) {
    throw new ValidationError("Cycle start date is required")
  }

  const id = await logMenstrualCycle(
    req.user!.id,
    cycleStart,
    symptoms || null,
  )
  res.status(201).json({ success: true, id })
})

router.get("/", async (req: Request, res: Response) => {
  const limit = queryLimit(req, { def: 12, max: 100 })
  const history = await getMenstrualHistory(req.user!.id, limit)
  res.json({ success: true, data: history })
})

router.get("/stats", async (req: Request, res: Response) => {
  const stats = await getCycleStats(req.user!.id)
  res.json({ success: true, data: stats })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "menstrual entry ID")
  const result = await deleteMenstrualEntry(req.user!.id, id)
  if (!result.deleted) throw new NotFoundError("Menstrual entry")
  // If this entry was a cycle start, client should remove predicted periods
  res.json({ success: true, removedPredictions: result.wasCycleStart })
})

router.get("/settings", async (req: Request, res: Response) => {
  const settings = await getMenstrualSettings(req.user!.id)
  res.json({ success: true, data: settings })
})

router.post("/settings", async (req: Request, res: Response) => {
  const { periodDays, cycleLengthDays } = req.body
  if (
    periodDays != null &&
    (!Number.isInteger(periodDays) || periodDays <= 0)
  ) {
    throw new ValidationError("periodDays must be a positive integer")
  }
  if (
    cycleLengthDays != null &&
    (!Number.isInteger(cycleLengthDays) || cycleLengthDays <= 0)
  ) {
    throw new ValidationError("cycleLengthDays must be a positive integer")
  }
  await setMenstrualSettings(req.user!.id, { periodDays, cycleLengthDays })
  res.json({ success: true })
})

export default router
