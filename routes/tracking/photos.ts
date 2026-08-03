// routes/tracking/photos.ts
import { Router, Request, Response } from "express"
import multer from "multer"
import { authenticateToken } from "../../middleware/auth.js"
import { asyncHandler, ValidationError } from "../../middleware/errorHandler.js"
import {
  saveProgressPhoto,
  getPhotoList,
  getPhotoData,
  deleteProgressPhoto,
  updatePhotoNote,
  tagPhotoWithMuscle,
  getPhotosByMuscle,
  getPhotosByMuscleWithNotes,
  comparePhotos,
  getPhotosByDateRange,
} from "../../models/tracking/photos.js"

const router: Router = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true)
    } else {
      cb(new Error("Only image files are allowed"))
    }
  },
})

router.use(authenticateToken)

/**
 * POST /api/tracking/photos
 */
router.post(
  "/",
  upload.single("photo"),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      throw new ValidationError("No photo file provided")
    }

    const { takenAt, note } = req.body
    const id = await saveProgressPhoto(
      req.user!.id,
      req.file.buffer,
      req.file.mimetype,
      takenAt || null,
      note || null,
    )

    res.status(201).json({ success: true, id })
  }),
)

/**
 * GET /api/tracking/photos
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
    const photos = await getPhotoList(req.user!.id, limit)
    res.json({ success: true, photos })
  }),
)

/**
 * GET /api/tracking/photos/:id
 */
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const photoId = parseInt(String(req.params.id))
    const result = await getPhotoData(req.user!.id, photoId)

    res.set("Content-Type", result.mimeType)
    res.set("Cache-Control", "private, max-age=86400")
    res.send(result.photoData)
  }),
)

/**
 * PATCH /api/tracking/photos/:id
 */
router.patch(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const photoId = parseInt(String(req.params.id))
    await updatePhotoNote(req.user!.id, photoId, req.body.note)
    res.json({ success: true })
  }),
)

/**
 * DELETE /api/tracking/photos/:id
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const photoId = parseInt(String(req.params.id))
    const deleted = await deleteProgressPhoto(req.user!.id, photoId)

    if (!deleted) {
      return res.status(404).json({ success: false, error: "Photo not found" })
    }

    res.json({ success: true })
  }),
)

// ─── Muscle tagging ───────────────────────────────────────────────────────────

/**
 * POST /api/tracking/photos/:id/muscle
 */
router.post(
  "/:id/muscle",
  asyncHandler(async (req: Request, res: Response) => {
    const photoId = parseInt(String(req.params.id))
    const { muscleGroup, muscleNotes } = req.body

    if (!muscleGroup) {
      throw new ValidationError("Muscle group is required")
    }

    await tagPhotoWithMuscle(
      req.user!.id,
      photoId,
      muscleGroup,
      muscleNotes || null,
    )
    res.json({ success: true })
  }),
)

/**
 * GET /api/tracking/photos/by-muscle/:muscleGroup
 */
router.get(
  "/by-muscle/:muscleGroup",
  asyncHandler(async (req: Request, res: Response) => {
    const muscleGroup = String(req.params.muscleGroup)
    const withNotes = req.query.notes === "true"
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)

    const photos = withNotes
      ? await getPhotosByMuscleWithNotes(req.user!.id, muscleGroup, limit)
      : await getPhotosByMuscle(req.user!.id, muscleGroup, limit)

    res.json({ success: true, photos })
  }),
)

// ─── Photo comparison ────────────────────────────────────────────────────────

/**
 * GET /api/tracking/photos/compare?before=id1&after=id2
 */
router.get(
  "/compare",
  asyncHandler(async (req: Request, res: Response) => {
    const beforeId = parseInt(req.query.before as string)
    const afterId = parseInt(req.query.after as string)

    if (isNaN(beforeId) || isNaN(afterId)) {
      throw new ValidationError("Both 'before' and 'after' photo IDs are required")
    }

    const comparison = await comparePhotos(req.user!.id, beforeId, afterId)
    res.json({ success: true, data: comparison })
  }),
)

/**
 * GET /api/tracking/photos/range/:startDate/:endDate
 */
router.get(
  "/range/:startDate/:endDate",
  asyncHandler(async (req: Request, res: Response) => {
    const startDate = String(req.params.startDate)
    const endDate = String(req.params.endDate)
    const { muscle } = req.query

    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      throw new ValidationError("Start date must be in YYYY-MM-DD format")
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      throw new ValidationError("End date must be in YYYY-MM-DD format")
    }

    const photos = await getPhotosByDateRange(
      req.user!.id,
      startDate,
      endDate,
      muscle ? String(muscle) : undefined,
    )
    res.json({ success: true, photos })
  }),
)

export default router
