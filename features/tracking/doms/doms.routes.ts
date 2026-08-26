import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import {
  queryLimit,
  parseIntParam,
  parseBackdatedTimestamp,
} from "@/middleware/validation.js"
import {
  ValidationError,
} from "@/middleware/errorHandler.js"
import {
  logSoreness,
  getActiveSoreness,
  updateSorenessWithFollowUp,
  batchFollowUp,
  getHistoryByMuscle,
  getDOMSStats,
} from "./doms.model.js"

const router: Router = Router()

router.use(authenticateToken)

router.post("/log", async (req: Request, res: Response) => {
  const { muscleGroup, intensity, notes, loggedAt } = req.body

  if (!muscleGroup || intensity === undefined || intensity === null) {
    throw new ValidationError("Muscle group and intensity are required")
  }

  const result = await logSoreness(
    req.user!.id,
    muscleGroup,
    intensity,
    notes || null,
    parseBackdatedTimestamp(loggedAt, "loggedAt"),
  )
  res.status(201).json({ success: true, data: result })
})

router.get("/active", async (req: Request, res: Response) => {
  const records = await getActiveSoreness(req.user!.id)
  res.json({ success: true, data: records })
})

router.put("/:id/followup", async (req: Request, res: Response) => {
  const sorenessId = parseIntParam(String(req.params.id), "soreness ID")

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
})

router.post("/batch-followup", async (req: Request, res: Response) => {
  const { updates } = req.body

  if (!Array.isArray(updates) || updates.length === 0) {
    throw new ValidationError("Updates array is required and must not be empty")
  }

  const results = await batchFollowUp(req.user!.id, updates)
  res.json({ success: true, data: results })
})

router.get("/history/:muscle", async (req: Request, res: Response) => {
  const muscle = String(req.params.muscle)
  const records = await getHistoryByMuscle(req.user!.id, muscle)
  res.json({ success: true, data: records })
})

router.get("/stats", async (req: Request, res: Response) => {
  const days = queryLimit(req, { def: 30, max: 365, key: "days" })
  const stats = await getDOMSStats(req.user!.id, days)
  res.json({ success: true, data: stats })
})

export default router
