import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { photoUpload, assertImageUpload } from "@/middleware/imageUpload.js"
import { ValidationError } from "@/middleware/errorHandler.js"
import {
  queryLimit,
  parseIntParam,
  parseBackdatedTimestamp,
} from "@/middleware/validation.js"
import {
  uploadPhoto,
  getAllPhotos,
  getPhotosByMuscle,
  getPhotoImage,
  deletePhoto,
} from "./progressPhoto.model.js"

const router: Router = Router()

router.use(authenticateToken)

router.post("/", photoUpload.single("photo"), async (req: Request, res: Response) => {
  assertImageUpload(req.file)

  const { takenAt, note, angle, customSideName } = req.body
  let muscleGroups: string[] = []
  if (req.body.muscleGroups) {
    try {
      muscleGroups = JSON.parse(req.body.muscleGroups)
    } catch {
      throw new ValidationError("muscleGroups must be a JSON array")
    }
  }
  if (!Array.isArray(muscleGroups) || muscleGroups.length === 0) {
    throw new ValidationError("At least one muscle group is required")
  }

  const id = await uploadPhoto(
    req.user!.id,
    req.file.buffer,
    req.file.mimetype,
    muscleGroups,
    note || null,
    angle || "custom",
    customSideName || null,
    parseBackdatedTimestamp(takenAt || null, "takenAt"),
  )

  res.status(201).json({ success: true, data: { id }, id })
})

router.get("/", async (req: Request, res: Response) => {
  const limit = queryLimit(req, { def: 100, max: 500 })
  const photos = await getAllPhotos(req.user!.id, limit)
  res.json({ success: true, data: photos })
})

router.get("/group/:muscle", async (req: Request, res: Response) => {
  const photos = await getPhotosByMuscle(
    req.user!.id,
    String(req.params.muscle),
    queryLimit(req, { def: 100, max: 500 }),
  )
  res.json({ success: true, data: photos })
})

// api-audit: external -- reached via the `uri` that formatMeta puts on every
// photo record, which the app resolves to an absolute URL and hands to <Image>.
router.get("/:id/image", async (req: Request, res: Response) => {
  const photoId = parseIntParam(String(req.params.id), "photo ID")
  const result = await getPhotoImage(req.user!.id, photoId)

  res.set("Content-Type", result.mimeType)
  // mime_type is constrained to an image allowlist at write time and helmet
  // sends nosniff globally, so this is belt-and-braces: it pins how a browser
  // treats the response rather than leaving it to content sniffing.
  res.set("Content-Disposition", "inline")
  res.set("Cache-Control", `private, max-age=${86_400}`)
  res.send(result.photoData)
})

router.delete("/:id", async (req: Request, res: Response) => {
  const photoId = parseIntParam(String(req.params.id), "photo ID")
  await deletePhoto(req.user!.id, photoId)
  res.json({ success: true })
})

export default router
