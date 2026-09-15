import multer from "multer"
import { ValidationError } from "./errorHandler.js"

// Transport-level gate for /api/tracking/photos/muscle uploads. The model
// still enforces its own narrower mime list.
// Kept in sync with the model's list deliberately: multer accepting a type the
// model rejects meant a 10 MB GIF was uploaded in full and then 400'd.
const ALLOWED_MIMETYPES = new Set(["image/jpeg", "image/png", "image/webp"])

export const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.has(file.mimetype)) cb(null, true)
    else cb(new ValidationError("Only JPEG, PNG, or WebP images are allowed"))
  },
})

// Content-Type is client-supplied and unverified, so check the magic bytes.
function matchesImageSignature(mimetype: string, buf: Buffer): boolean {
  switch (mimetype) {
    case "image/jpeg":
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    case "image/png":
      return buf
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case "image/gif":
      return (
        buf.subarray(0, 6).toString("ascii") === "GIF87a" ||
        buf.subarray(0, 6).toString("ascii") === "GIF89a"
      )
    case "image/webp":
      return (
        buf.subarray(0, 4).toString("ascii") === "RIFF" &&
        buf.subarray(8, 12).toString("ascii") === "WEBP"
      )
    default:
      return false
  }
}

/** Throws unless `file` is present and its bytes match its declared type. */
export function assertImageUpload(
  file: Express.Multer.File | undefined,
): asserts file is Express.Multer.File {
  if (!file) throw new ValidationError("No photo file provided")
  if (!matchesImageSignature(file.mimetype, file.buffer))
    throw new ValidationError("File content does not match declared image type")
}
