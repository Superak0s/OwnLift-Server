import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import { queryLimit, parseIntParam } from "@/middleware/validation.js"
import {
  logMenstrualCycle,
  getMenstrualHistory,
  getCycleStats,
  updateMenstrualCycle,
  deleteMenstrualEntry,
} from "./menstrual.model.js"

const router: Router = Router()

router.use(authenticateToken)

router.post("/", async (req: Request, res: Response) => {
  const { cycleStart, symptoms } = req.body
  if (!cycleStart) throw new ValidationError("Cycle start date is required")
  const entry = await logMenstrualCycle(req.user!.id, cycleStart, symptoms)
  res.status(201).json({ success: true, data: entry })
})

router.get("/", async (req: Request, res: Response) => {
  const history = await getMenstrualHistory(
    req.user!.id,
    queryLimit(req, { def: 12, max: 100 }),
  )
  res.json({ success: true, data: history })
})

router.get("/stats", async (req: Request, res: Response) => {
  res.json({ success: true, data: await getCycleStats(req.user!.id) })
})

/** The period ends and the symptom list grows after the cycle is logged. */
router.patch("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "menstrual entry ID")
  const { cycleEnd, symptoms } = req.body
  const entry = await updateMenstrualCycle(req.user!.id, id, {
    cycleEnd,
    symptoms,
  })
  res.json({ success: true, data: entry })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "menstrual entry ID")
  if (!(await deleteMenstrualEntry(req.user!.id, id)))
    throw new NotFoundError("Menstrual entry")
  res.json({ success: true })
})

// Period/cycle length preferences live in GET/PATCH /api/settings now, with
// every other preference — there are no /settings routes here any more.

export default router
