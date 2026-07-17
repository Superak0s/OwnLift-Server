// routes/tracking/photos.ts
import { Router, Request, Response } from "express"
import multer from "multer"
import { authenticateToken } from "../../middleware/auth"
import { asyncHandler, ValidationError } from "../../middleware/errorHandler"
import {
  saveProgressPhoto,
  getPhotoList,
  getPhotoData,
  deleteProgressPhoto,
  updatePhotoNote,
} from "../../models/tracking/photos"

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
    const photoId = parseInt(req.params.id)
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
    const photoId = parseInt(req.params.id)
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
    const photoId = parseInt(req.params.id)
    const deleted = await deleteProgressPhoto(req.user!.id, photoId)

    if (!deleted) {
      return res.status(404).json({ success: false, error: "Photo not found" })
    }

    res.json({ success: true })
  }),
)

export default router
