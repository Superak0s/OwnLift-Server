// routes/tracking/bodyStats.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import {
  asyncHandler,
  ValidationError,
  NotFoundError,
} from "../../middleware/errorHandler.js"
import { validateWeightEntry } from "../../middleware/validation.js"
import {
  logWeight,
  getWeightHistory,
  deleteWeightEntry,
  getCurrentWeight,
  getWeightStats,
  setHeight,
  getHeight,
  setWeightUnit,
  getWeightUnit,
  calculateBodyFatPercentage,
  logBodyFat,
  getBodyFatHistory,
  getLatestBodyFat,
  deleteBodyFatEntry,
  getBodyFatTrend,
  getUserBodyData,
} from "../../models/tracking/bodyStats.js"

const router: Router = Router()

router.use(authenticateToken)

// ─── Body weight ──────────────────────────────────────────────────────────────

router.post(
  "/weight",
  validateWeightEntry,
  asyncHandler(async (req: Request, res: Response) => {
    const { weightKg, recordedAt, note } = req.body
    const id = await logWeight(
      req.user!.id,
      weightKg,
      recordedAt || null,
      note || null,
    )
    res.status(201).json({ success: true, id })
  }),
)

router.get(
  "/weight/current",
  asyncHandler(async (req: Request, res: Response) => {
    const entry = await getCurrentWeight(req.user!.id)
    res.json({ success: true, entry })
  }),
)

router.get(
  "/weight",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 90, 365)
    const entries = await getWeightHistory(req.user!.id, limit)
    res.json({ success: true, entries })
  }),
)

router.get(
  "/weight/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query.days as string) || 30, 365)
    const stats = await getWeightStats(req.user!.id, days)
    res.json({ success: true, stats })
  }),
)

router.delete(
  "/weight/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const entryId = parseInt(String(req.params.id))
    const deleted = await deleteWeightEntry(req.user!.id, entryId)
    if (!deleted) throw new NotFoundError("Weight entry")
    res.json({ success: true })
  }),
)

// ─── Height & unit preferences ────────────────────────────────────────────────

router.put(
  "/height",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const { heightCm, heightUnit, weightUnit } = req.body

    if (heightCm !== undefined) {
      if (typeof heightCm !== "number" || heightCm <= 0) {
        throw new ValidationError("heightCm must be a positive number")
      }
      await setHeight(userId, heightCm, heightUnit || "cm")
    }

    if (weightUnit) {
      if (!["kg", "lbs"].includes(weightUnit)) {
        throw new ValidationError('weightUnit must be "kg" or "lbs"')
      }
      await setWeightUnit(userId, weightUnit)
    }

    res.json({ success: true })
  }),
)

router.get(
  "/height",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const heightData = await getHeight(userId)
    const weightUnit = await getWeightUnit(userId)

    const responseHeight = heightData
      ? {
          height_cm:
            typeof heightData.heightCm === "string"
              ? parseFloat(heightData.heightCm)
              : heightData.heightCm,
          height_unit: heightData.unit || "cm",
        }
      : null

    res.json({
      success: true,
      height: responseHeight,
      weightUnit: weightUnit || "kg",
    })
  }),
)

// ─── Body fat ─────────────────────────────────────────────────────────────────

router.post(
  "/bodyfat/log",
  asyncHandler(async (req: Request, res: Response) => {
    const { percentage, measurements, calculatedAt, gender } = req.body
    const userId = req.user!.id

    if (percentage == null || measurements == null) {
      throw new ValidationError("percentage and measurements are required")
    }

    // Validate percentage BEFORE any DB calls
    if (typeof percentage !== "number" || percentage < 0 || percentage > 100) {
      throw new ValidationError(
        `Invalid body fat percentage: ${percentage}%. Must be between 0-100%.`,
      )
    }

    const { waist, neck, hip, unit } = measurements

    if (!waist || waist <= 0)
      throw new ValidationError("Invalid waist measurement")
    if (!neck || neck <= 0)
      throw new ValidationError("Invalid neck measurement")
    if (gender === "female" && (!hip || hip <= 0)) {
      throw new ValidationError(
        "Invalid hip measurement (required for females)",
      )
    }

    let waistCm: number = waist
    let neckCm: number = neck
    let hipCm: number | null = hip || null

    if (unit === "in") {
      waistCm = waist * 2.54
      neckCm = neck * 2.54
      if (hip) hipCm = hip * 2.54
    }

    if (waistCm <= neckCm) {
      throw new ValidationError(
        "Waist measurement must be greater than neck measurement",
      )
    }

    const userData = await getUserBodyData(userId)
    if (!userData || !userData.heightCm) {
      throw new ValidationError(
        "User height not set. Please set your height in settings first.",
      )
    }

    const calculatedPercentage = calculateBodyFatPercentage(
      gender,
      userData.heightCm,
      waistCm,
      neckCm,
      hipCm,
    )

    if (Math.abs(calculatedPercentage - percentage) > 0.5) {
      console.warn("Body fat calculation mismatch:", {
        provided: percentage,
        calculated: calculatedPercentage,
      })
    }

    const entry = await logBodyFat(
      userId,
      percentage,
      waistCm,
      neckCm,
      hipCm,
      userData.heightCm,
      userData.gender,
      calculatedAt || new Date().toISOString(),
    )

    res.json({
      success: true,
      entry: {
        id: (entry as any).id,
        percentage: (entry as any).percentage,
        measurements: {
          waist: (entry as any).waist_cm,
          neck: (entry as any).neck_cm,
          hip: (entry as any).hip_cm,
          unit: "cm",
        },
        calculatedAt: (entry as any).calculated_at,
      },
    })
  }),
)

router.get(
  "/bodyfat/log",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 90, 365)
    const entries = await getBodyFatHistory(req.user!.id, limit)
    res.json({ success: true, entries })
  }),
)

router.get(
  "/bodyfat/latest",
  asyncHandler(async (req: Request, res: Response) => {
    const entry = await getLatestBodyFat(req.user!.id)
    res.json({ success: true, entry })
  }),
)

router.delete(
  "/bodyfat/log/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const deleted = await deleteBodyFatEntry(
      req.user!.id,
      parseInt(String(req.params.id)),
    )
    if (!deleted) throw new NotFoundError("Body fat entry")
    res.json({ success: true, message: "Entry deleted successfully" })
  }),
)

router.get(
  "/bodyfat/trend",
  asyncHandler(async (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query.days as string) || 90, 365)
    const result = await getBodyFatTrend(req.user!.id, days)
    res.json({ success: true, ...result })
  }),
)

router.post(
  "/bodyfat/calculate",
  asyncHandler(async (req: Request, res: Response) => {
    const { waist, neck, hip, unit } = req.body
    const userId = req.user!.id

    if (!waist || waist <= 0)
      throw new ValidationError("Invalid waist measurement")
    if (!neck || neck <= 0)
      throw new ValidationError("Invalid neck measurement")

    const userData = await getUserBodyData(userId)
    if (!userData || !userData.heightCm) {
      throw new ValidationError(
        "User height not set. Please set your height in settings first.",
      )
    }

    let waistCm: number = waist
    let neckCm: number = neck
    let hipCm: number | null = hip || null

    if (unit === "in") {
      waistCm = waist * 2.54
      neckCm = neck * 2.54
      if (hip) hipCm = hip * 2.54
    }

    if (waistCm <= neckCm) {
      throw new ValidationError(
        "Waist measurement must be greater than neck measurement",
      )
    }

    if (userData.gender === "female" && (!hipCm || hipCm <= 0)) {
      throw new ValidationError(
        "Hip measurement required for female body fat calculation",
      )
    }

    const percentage = calculateBodyFatPercentage(
      userData.gender,
      userData.heightCm,
      waistCm,
      neckCm,
      hipCm,
    )

    res.json({
      success: true,
      percentage,
      measurements: {
        waist: waistCm,
        neck: neckCm,
        hip: hipCm,
        height: userData.heightCm,
        unit: "cm",
      },
      method: "us_navy",
    })
  }),
)

export default router
