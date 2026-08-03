// routes/tracking/progressPhoto.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import {
  asyncHandler,
  ValidationError,
} from "../../middleware/errorHandler.js"
import {
  uploadPhoto,
  getAllPhotos,
  getPhotosByMuscle,
  filterPhotosByMuscles,
  getPhotosByDateRange,
  deletePhoto,
  updatePhotoTags,
} from "../../models/tracking/progressPhoto.js"

const router: Router = Router()

router.use(authenticateToken)

// ─── Upload photo ────────────────────────────────────────────────────────────

/**
 * POST /api/tracking/progress-photos
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { uri, muscleGroups, notes, angle, takenAt } = req.body

    if (!uri) {
      throw new ValidationError("Photo URI is required")
    }
    if (!Array.isArray(muscleGroups) || muscleGroups.length === 0) {
      throw new ValidationError("At least one muscle group is required")
    }

    const result = await uploadPhoto(
      req.user!.id,
      uri,
      muscleGroups,
      notes || null,
      angle,
      takenAt || null,
    )
    res.status(201).json({ success: true, data: result })
  }),
)

// ─── Get all photos ──────────────────────────────────────────────────────────

/**
 * GET /api/tracking/progress-photos?limit=N
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(String(req.query.limit)) : 100
    const photos = await getAllPhotos(req.user!.id, limit)
    res.json({ success: true, data: photos })
  }),
)

// ─── Get photos by muscle ────────────────────────────────────────────────────

/**
 * GET /api/tracking/progress-photos/muscle/:muscle
 */
router.get(
  "/muscle/:muscle",
  asyncHandler(async (req: Request, res: Response) => {
    const muscle = String(req.params.muscle)
    const photos = await getPhotosByMuscle(req.user!.id, muscle)
    res.json({ success: true, data: photos })
  }),
)

// ─── Filter photos by multiple muscles ───────────────────────────────────────

/**
 * POST /api/tracking/progress-photos/filter
 */
router.post(
  "/filter",
  asyncHandler(async (req: Request, res: Response) => {
    const { muscleGroups } = req.body

    if (!Array.isArray(muscleGroups) || muscleGroups.length === 0) {
      throw new ValidationError("muscleGroups array is required")
    }

    const photos = await filterPhotosByMuscles(req.user!.id, muscleGroups)
    res.json({ success: true, data: photos })
  }),
)

// ─── Get photos by date range ────────────────────────────────────────────────

/**
 * GET /api/tracking/progress-photos/range?start=YYYY-MM-DD&end=YYYY-MM-DD
 */
router.get(
  "/range",
  asyncHandler(async (req: Request, res: Response) => {
    const startDate = req.query.start as string
    const endDate = req.query.end as string

    if (!startDate || !endDate) {
      throw new ValidationError("Both 'start' and 'end' query params are required")
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      throw new ValidationError("Start date must be in YYYY-MM-DD format")
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      throw new ValidationError("End date must be in YYYY-MM-DD format")
    }

    const photos = await getPhotosByDateRange(req.user!.id, startDate, endDate)
    res.json({ success: true, data: photos })
  }),
)

// ─── Update photo tags ───────────────────────────────────────────────────────

/**
 * PUT /api/tracking/progress-photos/:id/tags
 */
router.put(
  "/:id/tags",
  asyncHandler(async (req: Request, res: Response) => {
    const photoId = parseInt(String(req.params.id))
    if (isNaN(photoId)) throw new ValidationError("Invalid photo ID")

    const { muscleGroups, notes } = req.body

    if (!Array.isArray(muscleGroups) || muscleGroups.length === 0) {
      throw new ValidationError("At least one muscle group is required")
    }

    const result = await updatePhotoTags(req.user!.id, photoId, muscleGroups, notes)
    res.json({ success: true, data: result })
  }),
)

// ─── Delete photo ────────────────────────────────────────────────────────────

/**
 * DELETE /api/tracking/progress-photos/:id
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const photoId = parseInt(String(req.params.id))
    if (isNaN(photoId)) throw new ValidationError("Invalid photo ID")

    const deleted = await deletePhoto(req.user!.id, photoId)
    if (!deleted) throw new ValidationError("Photo not found")
    res.json({ success: true, data: null })
  }),
)

export default router
