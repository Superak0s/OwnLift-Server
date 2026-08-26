import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { parseIntParam } from "@/middleware/validation.js"
import {
  createMeasurementType,
  getMeasurementTypes,
  logCustomMeasurement,
} from "./customMeasurements.model.js"

const router: Router = Router()
router.use(authenticateToken)

router.post("/types", async (req: Request, res: Response) => {
  const { keyName, label, unit } = req.body
  const type = await createMeasurementType(req.user!.id, keyName, label, unit || null)
  res.status(201).json({ success: true, data: type })
})

router.get("/types", async (req: Request, res: Response) => {
  const types = await getMeasurementTypes(req.user!.id)
  res.json({ success: true, data: types })
})

router.post("/values", async (req: Request, res: Response) => {
  const { typeId, value, measuredAt, note } = req.body
  const id = await logCustomMeasurement(
    req.user!.id,
    parseIntParam(String(typeId), "typeId"),
    parseFloat(value),
    measuredAt || null,
    note || null,
  )
  res.status(201).json({ success: true, id })
})

export default router
