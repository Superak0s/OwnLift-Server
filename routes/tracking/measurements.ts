// routes/tracking/measurements.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import { asyncHandler, ValidationError } from "../../middleware/errorHandler.js"
import {
  createMeasurementType,
  getMeasurementTypes,
  deleteMeasurementType,
  logCustomMeasurement,
  getCustomMeasurementsForDate,
  getMeasurementValues,
} from "../../models/tracking/customMeasurements.js"

const router: Router = Router()
router.use(authenticateToken)

// Create a custom measurement type
router.post(
  "/types",
  asyncHandler(async (req: Request, res: Response) => {
    const { keyName, label, unit } = req.body
    if (!keyName || !label) throw new ValidationError("keyName and label are required")
    const type = await createMeasurementType(req.user!.id, keyName, label, unit || null)
    res.status(201).json({ success: true, data: type })
  }),
)

// List custom measurement types
router.get(
  "/types",
  asyncHandler(async (req: Request, res: Response) => {
    const types = await getMeasurementTypes(req.user!.id)
    res.json({ success: true, data: types })
  }),
)

// Delete a custom measurement type
router.delete(
  "/types/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id))
    if (isNaN(id)) throw new ValidationError("Invalid type id")
    const ok = await deleteMeasurementType(req.user!.id, id)
    if (!ok) throw new ValidationError("Measurement type not found")
    res.json({ success: true })
  }),
)

// Log a custom measurement value
router.post(
  "/values",
  asyncHandler(async (req: Request, res: Response) => {
    const { typeId, value, measuredAt, note } = req.body
    if (!typeId || value == null) throw new ValidationError("typeId and value are required")
    const id = await logCustomMeasurement(req.user!.id, parseInt(typeId), parseFloat(value), measuredAt || null, note || null)
    res.status(201).json({ success: true, id })
  }),
)

// Get custom measurements for a specific date (YYYY-MM-DD)
router.get(
  "/values/:date",
  asyncHandler(async (req: Request, res: Response) => {
    const date = String(req.params.date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError("Date must be in YYYY-MM-DD format")
    const values = await getCustomMeasurementsForDate(req.user!.id, date)
    res.json({ success: true, data: values })
  }),
)

// Get recent values for a custom measurement type
router.get(
  "/values/type/:typeId",
  asyncHandler(async (req: Request, res: Response) => {
    const typeId = parseInt(String(req.params.typeId))
    const limit = req.query.limit ? parseInt(String(req.query.limit)) : 90
    if (isNaN(typeId)) throw new ValidationError("Invalid typeId")
    const values = await getMeasurementValues(req.user!.id, typeId, limit)
    res.json({ success: true, data: values })
  }),
)

export default router
