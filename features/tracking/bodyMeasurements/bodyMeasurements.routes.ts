import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { queryLimit, parseIntParam } from "@/middleware/validation.js"
import {
  ValidationError,
} from "@/middleware/errorHandler.js"
import {
  logMeasurement,
  getMeasurementHistory,
  deleteMeasurementEntry,
} from "./bodyMeasurements.model.js"

const router: Router = Router()

router.use(authenticateToken)

router.post("/", async (req: Request, res: Response) => {
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
})

router.get("/", async (req: Request, res: Response) => {
  const limit = queryLimit(req, { def: 90, max: 365 })
  const history = await getMeasurementHistory(req.user!.id, limit)
  res.json({ success: true, data: history })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "measurement ID")
  const deleted = await deleteMeasurementEntry(req.user!.id, id)
  if (!deleted) throw new ValidationError("Measurement not found")
  res.json({ success: true })
})

export default router
