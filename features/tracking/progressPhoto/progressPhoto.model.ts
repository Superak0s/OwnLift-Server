// Progress photos: metadata in progress_photos, bytes in progress_photo_blobs.
//
// The split is the point. Every listing query used to read a table whose rows
// carried a LONGBLOB, so InnoDB dragged pages of image data through the buffer
// pool to return a date and an angle. The blob now lives in its own table and
// is only touched by GET /:id/image.

import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
] as const
const MAX_PHOTO_SIZE = 10 * 1024 * 1024
const ALLOWED_ANGLES = ["front", "back", "side", "custom"] as const
const MAX_MUSCLE_NAME_LENGTH = 128

interface ProgressPhotoMeta extends RowDataPacket {
  id: number
  takenAt: string
  note: string | null
  angle: string
  customSideName: string | null
  createdAt: string
  /** JSON_ARRAYAGG, so the driver hands back a real array — or null for none. */
  muscleGroups: string[] | null
}

// The muscle groups come from a correlated subquery rather than a LEFT JOIN +
// GROUP BY: no grouping over the metadata columns, and an untagged photo comes
// back as NULL instead of a one-null array.
const SELECT_PHOTOS = `
  SELECT p.id, p.taken_at AS takenAt, p.note, p.angle,
         p.custom_side_name AS customSideName, p.created_at AS createdAt,
         (SELECT JSON_ARRAYAGG(m.muscle_group) FROM progress_photo_muscles m
           WHERE m.photo_id = p.id) AS muscleGroups
  FROM progress_photos p
`

/** The `uri` the app hands to <Image>; not a stored column. */
function withUri(row: ProgressPhotoMeta) {
  return {
    ...row,
    muscleGroups: row.muscleGroups ?? [],
    uri: `/api/tracking/photos/muscle/${row.id}/image`,
  }
}

export async function uploadPhoto(
  userId: number,
  photoBuffer: Buffer,
  mimeType: string,
  muscleGroups: string[],
  note: string | null,
  angle: string,
  customSideName: string | null,
  takenAt?: string | null,
): Promise<number> {
  if (!Buffer.isBuffer(photoBuffer) || photoBuffer.length === 0)
    throw new ValidationError("Invalid photo data")
  if (photoBuffer.length > MAX_PHOTO_SIZE)
    throw new ValidationError(
      `Photo size exceeds ${MAX_PHOTO_SIZE / (1024 * 1024)}MB limit`,
    )
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType))
    throw new ValidationError("Invalid image type. Allowed: JPEG, PNG, WebP")
  if (!(ALLOWED_ANGLES as readonly string[]).includes(angle))
    throw new ValidationError("Invalid angle")
  if (muscleGroups.length > 20)
    throw new ValidationError("Too many muscle groups")
  // A muscle group is a row now, not a piece of a comma-joined string, so a
  // comma in the name is just a character.
  if (muscleGroups.some((m) => typeof m !== "string" || !m || m.length > MAX_MUSCLE_NAME_LENGTH))
    throw new ValidationError("Invalid muscle group")

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO progress_photos
         (user_id, mime_type, file_size, taken_at, note, angle, custom_side_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        mimeType,
        photoBuffer.length,
        formatDateForMySQL(takenAt ? takenAt : new Date()),
        note ?? null,
        angle,
        customSideName ?? null,
      ],
    )
    const photoId = result.insertId

    await connection.execute(
      `INSERT INTO progress_photo_blobs (photo_id, data) VALUES (?, ?)`,
      [photoId, photoBuffer],
    )

    const unique = [...new Set(muscleGroups)]
    await connection.execute(
      `INSERT INTO progress_photo_muscles (photo_id, muscle_group) VALUES
       ${unique.map(() => "(?, ?)").join(", ")}`,
      unique.flatMap((m) => [photoId, m]),
    )

    await connection.commit()
    return photoId
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
}

export async function getAllPhotos(userId: number, limit = 100) {
  const [rows] = await pool.execute<ProgressPhotoMeta[]>(
    `${SELECT_PHOTOS} WHERE p.user_id = ? ORDER BY p.taken_at DESC LIMIT ?`,
    [userId, limit],
  )
  return rows.map(withUri)
}

export async function getPhotosByMuscle(
  userId: number,
  muscleGroup: string,
  limit = 100,
) {
  const [rows] = await pool.execute<ProgressPhotoMeta[]>(
    `${SELECT_PHOTOS}
     WHERE p.user_id = ? AND EXISTS (
       SELECT 1 FROM progress_photo_muscles m
        WHERE m.photo_id = p.id AND m.muscle_group = ?)
     ORDER BY p.taken_at DESC LIMIT ?`,
    [userId, muscleGroup, limit],
  )
  return rows.map(withUri)
}

export async function getPhotoImage(
  userId: number,
  photoId: number,
): Promise<{ photoData: Buffer; mimeType: string }> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT b.data AS photoData, p.mime_type AS mimeType
     FROM progress_photos p JOIN progress_photo_blobs b ON b.photo_id = p.id
     WHERE p.id = ? AND p.user_id = ?`,
    [photoId, userId],
  )
  if (!rows[0]) throw new NotFoundError("Photo")
  return { photoData: rows[0].photoData, mimeType: rows[0].mimeType }
}

export async function deletePhoto(
  userId: number,
  photoId: number,
): Promise<boolean> {
  // The blob and the tags follow: both FKs are ON DELETE CASCADE.
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM progress_photos WHERE id = ? AND user_id = ?`,
    [photoId, userId],
  )
  if (result.affectedRows === 0) throw new NotFoundError("Photo")
  return true
}
