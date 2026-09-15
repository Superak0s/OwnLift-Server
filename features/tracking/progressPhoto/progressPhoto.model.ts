import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"] as const
const MAX_PHOTO_SIZE = 10 * 1024 * 1024
const ALLOWED_ANGLES = ["front", "back", "side", "custom"] as const

interface ProgressPhotoMuscleMeta {
  id: number
  takenAt: Date
  uri: string
  muscleGroups: string[]
  notes: string | null
  angle: string
  customSideName: string | null
  createdAt: Date
}

interface PhotoMetaRow extends RowDataPacket {
  id: number
  taken_at: Date
  notes: string | null
  angle: string
  custom_side_name: string | null
  created_at: Date
  muscle_groups: string | null
}

function formatMeta(row: PhotoMetaRow): ProgressPhotoMuscleMeta {
  return {
    id: row.id,
    takenAt: row.taken_at,
    uri: `/api/tracking/photos/muscle/${row.id}/image`,
    muscleGroups: row.muscle_groups ? row.muscle_groups.split(",") : [],
    notes: row.notes,
    angle: row.angle,
    customSideName: row.custom_side_name,
    createdAt: row.created_at,
  }
}

const SELECT_WITH_TAGS = `
  SELECT p.id, p.taken_at, p.notes, p.angle, p.custom_side_name, p.created_at,
         GROUP_CONCAT(t.muscle_group) AS muscle_groups
  FROM progress_photos_muscle p
  LEFT JOIN progress_photos_muscle_tags t ON t.photo_id = p.id
`

export async function uploadPhoto(
  userId: number,
  photoBuffer: Buffer,
  mimeType: string,
  muscleGroups: string[],
  notes: string | null,
  angle: string,
  customSideName: string | null,
  takenAt?: string | null,
): Promise<number> {
  if (!Buffer.isBuffer(photoBuffer) || photoBuffer.length === 0)
    throw new ValidationError("Invalid photo data")
  if (photoBuffer.length > MAX_PHOTO_SIZE)
    throw new ValidationError(`Photo size exceeds ${MAX_PHOTO_SIZE / (1024 * 1024)}MB limit`)
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType))
    throw new ValidationError("Invalid image type. Allowed: JPEG, PNG, WebP")
  if (!(ALLOWED_ANGLES as readonly string[]).includes(angle))
    throw new ValidationError("Invalid angle")
  if (muscleGroups.length > 20)
    throw new ValidationError("Too many muscle groups")
  // GROUP_CONCAT-joined on read, so commas would corrupt the split
  if (muscleGroups.some((m) => !m || m.length > 50 || m.includes(",")))
    throw new ValidationError("Invalid muscle group")

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO progress_photos_muscle (user_id, photo_data, mime_type, file_size, taken_at, notes, angle, custom_side_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        photoBuffer,
        mimeType,
        photoBuffer.length,
        formatDateForMySQL(takenAt ? takenAt : new Date()),
        notes ?? null,
        angle,
        customSideName ?? null,
      ],
    )
    const photoId = result.insertId

    for (const muscleGroup of muscleGroups) {
      await connection.execute(
        `INSERT INTO progress_photos_muscle_tags (photo_id, muscle_group) VALUES (?, ?)`,
        [photoId, muscleGroup],
      )
    }

    await connection.commit()
    return photoId
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
}

export async function getAllPhotos(
  userId: number,
  limit = 100,
): Promise<ProgressPhotoMuscleMeta[]> {
  const [rows] = await pool.execute<PhotoMetaRow[]>(
    `${SELECT_WITH_TAGS} WHERE p.user_id = ? GROUP BY p.id ORDER BY p.taken_at DESC LIMIT ?`,
    [userId, limit],
  )
  return rows.map(formatMeta)
}

export async function getPhotosByMuscle(
  userId: number,
  muscleGroup: string,
  limit = 100,
): Promise<ProgressPhotoMuscleMeta[]> {
  const [rows] = await pool.execute<PhotoMetaRow[]>(
    `${SELECT_WITH_TAGS}
     WHERE p.user_id = ? AND p.id IN (
       SELECT photo_id FROM progress_photos_muscle_tags WHERE muscle_group = ?
     )
     GROUP BY p.id ORDER BY p.taken_at DESC LIMIT ?`,
    [userId, muscleGroup, limit],
  )
  return rows.map(formatMeta)
}

export async function getPhotoImage(
  userId: number,
  photoId: number,
): Promise<{ photoData: Buffer; mimeType: string }> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT photo_data, mime_type FROM progress_photos_muscle WHERE id = ? AND user_id = ?`,
    [photoId, userId],
  )
  if (!rows[0]) throw new NotFoundError("Photo")
  return { photoData: rows[0].photo_data, mimeType: rows[0].mime_type }
}

export async function deletePhoto(userId: number, photoId: number): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM progress_photos_muscle WHERE id = ? AND user_id = ?`,
    [photoId, userId],
  )
  if (result.affectedRows === 0)
    throw new NotFoundError("Photo")
  return true
}
