// routes/tracking/injury.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import {
  asyncHandler,
  ValidationError,
} from "../../middleware/errorHandler.js"
import {
  logInjury,
  updateInjury,
  getAllInjuries,
  getInjuriesByMuscle,
  getActiveInjuries,
  deleteInjury,
} from "../../models/tracking/injury.js"

const router: Router = Router()

router.use(authenticateToken)

// ─── Log injury ──────────────────────────────────────────────────────────────

/**
 * POST /api/tracking/injuries
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { muscleGroup, injuryType, painLevel, startDate, notes } = req.body

    if (!muscleGroup || !injuryType || painLevel === undefined || painLevel === null) {
      throw new ValidationError("Muscle group, injury type, and pain level are required")
    }

    const result = await logInjury(
      req.user!.id,
      muscleGroup,
      injuryType,
      painLevel,
      startDate || new Date().toISOString(),
      notes || null,
    )
    res.status(201).json({ success: true, data: result })
  }),
)

// ─── Update injury ───────────────────────────────────────────────────────────

/**
 * PUT /api/tracking/injuries/:id
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const injuryId = parseInt(String(req.params.id))
    if (isNaN(injuryId)) throw new ValidationError("Invalid injury ID")

    const { status, recoveryDate, notes, painLevel } = req.body

    const result = await updateInjury(req.user!.id, injuryId, {
      status,
      recoveryDate,
      notes,
      painLevel,
    })
    res.json({ success: true, data: result })
  }),
)

// ─── Get all injuries ────────────────────────────────────────────────────────

/**
 * GET /api/tracking/injuries
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const injuries = await getAllInjuries(req.user!.id)
    res.json({ success: true, data: injuries })
  }),
)

// ─── Get injuries by muscle ──────────────────────────────────────────────────

/**
 * GET /api/tracking/injuries/muscle/:muscle
 */
router.get(
  "/muscle/:muscle",
  asyncHandler(async (req: Request, res: Response) => {
    const muscle = String(req.params.muscle)
    const injuries = await getInjuriesByMuscle(req.user!.id, muscle)
    res.json({ success: true, data: injuries })
  }),
)

// ─── Get active injuries ─────────────────────────────────────────────────────

/**
 * GET /api/tracking/injuries/active
 */
router.get(
  "/active",
  asyncHandler(async (req: Request, res: Response) => {
    const injuries = await getActiveInjuries(req.user!.id)
    res.json({ success: true, data: injuries })
  }),
)

// ─── Delete injury ───────────────────────────────────────────────────────────

/**
 * DELETE /api/tracking/injuries/:id
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const injuryId = parseInt(String(req.params.id))
    if (isNaN(injuryId)) throw new ValidationError("Invalid injury ID")

    const deleted = await deleteInjury(req.user!.id, injuryId)
    if (!deleted) throw new ValidationError("Injury not found")
    res.json({ success: true, data: null })
  }),
)

export default router
