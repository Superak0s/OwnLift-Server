import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import {
  ValidationError,
  NotFoundError,
} from "@/middleware/errorHandler.js"
import { validateWeightEntry, queryLimit, parseIntParam } from "@/middleware/validation.js"
import { logger } from "@/utils/logger.js"
import {
  logWeight,
  getWeightHistory,
  deleteWeightEntry,
  getCurrentWeight,
  calculateBodyFatPercentage,
  logBodyFat,
  getBodyFatHistory,
  deleteBodyFatEntry,
} from "./bodyStats.model.js"
import { getUserBodyData } from "@/features/auth/user.model.js"

const router: Router = Router()

router.use(authenticateToken)

router.post("/weight", validateWeightEntry, async (req: Request, res: Response) => {
  const { weightKg, recordedAt, note } = req.body
  const id = await logWeight(
    req.user!.id,
    weightKg,
    recordedAt || null,
    note || null,
  )
  res.status(201).json({ success: true, id })
})

router.get("/weight/current", async (req: Request, res: Response) => {
  const entry = await getCurrentWeight(req.user!.id)
  res.json({ success: true, entry })
})

router.get("/weight", async (req: Request, res: Response) => {
  const limit = queryLimit(req, { def: 90, max: 365 })
  const entries = await getWeightHistory(req.user!.id, limit)
  res.json({ success: true, entries })
})

router.delete("/weight/:id", async (req: Request, res: Response) => {
  const entryId = parseIntParam(String(req.params.id), "weight entry ID")
  const deleted = await deleteWeightEntry(req.user!.id, entryId)
  if (!deleted) throw new NotFoundError("Weight entry")
  res.json({ success: true })
})

router.post("/bodyfat/log", async (req: Request, res: Response) => {
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

  // The client only sends gender when it differs from the profile, so fall
  // back to the stored one — the formula picks a different branch per sex.
  const userData = await getUserBodyData(userId)
  const sex: "male" | "female" = gender ?? userData.gender

  if (!waist || waist <= 0)
    throw new ValidationError("Invalid waist measurement")
  if (!neck || neck <= 0)
    throw new ValidationError("Invalid neck measurement")
  if (sex === "female" && (!hip || hip <= 0)) {
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

  // Height is only used to re-derive the percentage as a cross-check and to
  // stamp the entry — the client already did the maths with its own copy. A
  // profile without a height skips the check instead of rejecting the log.
  if (userData.heightCm) {
    const calculatedPercentage = calculateBodyFatPercentage(
      sex,
      userData.heightCm,
      waistCm,
      neckCm,
      hipCm,
    )

    if (Math.abs(calculatedPercentage - percentage) > 0.5) {
      logger.warn("Body fat calculation mismatch:", {
        provided: percentage,
        calculated: calculatedPercentage,
      })
    }
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

  res.json({ success: true, entry })
})

router.get("/bodyfat/log", async (req: Request, res: Response) => {
  const limit = queryLimit(req, { def: 90, max: 365 })
  const entries = await getBodyFatHistory(req.user!.id, limit)
  res.json({ success: true, entries })
})

router.delete("/bodyfat/log/:id", async (req: Request, res: Response) => {
  const entryId = parseIntParam(String(req.params.id), "body fat entry ID")
  const deleted = await deleteBodyFatEntry(req.user!.id, entryId)
  if (!deleted) throw new NotFoundError("Body fat entry")
  res.json({ success: true, message: "Entry deleted successfully" })
})

export default router
