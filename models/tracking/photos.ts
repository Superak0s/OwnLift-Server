// src/models/tracking/photos.ts
import { pool } from "../../config/database"
import { query as dbQuery } from "../../config/database"
import type { RowDataPacket } from "mysql2"
import type { InsertResult } from "../../types"
import { formatDateForMySQL } from "../utils/dateHelpers"
import { NotFoundError, ValidationError } from "../../middleware/errorHandler"
import type { PhotoMetadata, PhotoData } from "../../types"

export type { PhotoMetadata, PhotoData }

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
] as const
const MAX_PHOTO_SIZE = 10 * 1024 * 1024 // 10 MB

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface PhotoMetaRow extends RowDataPacket {
  id: number
  mime_type: string
  file_size: number
  taken_at: Date
  note: string | null
  created_at: Date
}

interface PhotoDataRow extends RowDataPacket {
  photo_data: Buffer
  mime_type: string
}


interface CountRow extends RowDataPacket {
  count: number
}

interface TotalRow extends RowDataPacket {
  total: number | null
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function saveProgressPhoto(
  userId: number,
  photoBuffer: Buffer,
  mimeType = "image/jpeg",
  takenAt?: string | null,
  note?: string | null,
): Promise<number> {
  if (!Buffer.isBuffer(photoBuffer) || photoBuffer.length === 0)
    throw new ValidationError("Invalid photo data")
  if (photoBuffer.length > MAX_PHOTO_SIZE)
    throw new ValidationError("Photo size exceeds 10MB limit")
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType))
    throw new ValidationError("Invalid image type. Allowed: JPEG, PNG, WebP")

  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `INSERT INTO progress_photos (user_id, photo_data, mime_type, file_size, taken_at, note) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      photoBuffer,
      mimeType,
      photoBuffer.length,
      formatDateForMySQL(takenAt ? takenAt : new Date()),
      note ?? null,
    ],
  )
  return (result as unknown as InsertResult).insertId
}

export async function getPhotoList(
  userId: number,
  limit = 50,
): Promise<PhotoMetadata[]> {
  const [rows] = await dbQuery<PhotoMetaRow[]>(
    `SELECT id, mime_type, file_size, taken_at, note, created_at FROM progress_photos WHERE user_id = ? ORDER BY taken_at DESC LIMIT ?`,
    [userId, limit],
  )
  return rows.map(formatMeta)
}

export async function getPhotoData(
  userId: number,
  photoId: number,
): Promise<PhotoData> {
  const [rows] = await dbQuery<PhotoDataRow[]>(
    `SELECT photo_data, mime_type FROM progress_photos WHERE id = ? AND user_id = ?`,
    [photoId, userId],
  )
  if (!rows[0]) throw new NotFoundError("Photo")
  return { photoData: rows[0].photo_data, mimeType: rows[0].mime_type }
}

export async function getPhotoMetadata(
  userId: number,
  photoId: number,
): Promise<PhotoMetadata> {
  const [rows] = await dbQuery<PhotoMetaRow[]>(
    `SELECT id, mime_type, file_size, taken_at, note, created_at FROM progress_photos WHERE id = ? AND user_id = ?`,
    [photoId, userId],
  )
  if (!rows[0]) throw new NotFoundError("Photo")
  return formatMeta(rows[0])
}

export async function updatePhotoNote(
  userId: number,
  photoId: number,
  note: string,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`UPDATE progress_photos SET note = ? WHERE id = ? AND user_id = ?`, [
    note,
    photoId,
    userId,
  ])
  if ((result as unknown as InsertResult).affectedRows === 0)
    throw new NotFoundError("Photo")
  return true
}

export async function deleteProgressPhoto(
  userId: number,
  photoId: number,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`DELETE FROM progress_photos WHERE id = ? AND user_id = ?`, [
    photoId,
    userId,
  ])
  if ((result as unknown as InsertResult).affectedRows === 0)
    throw new NotFoundError("Photo")
  return true
}

export async function getPhotoCount(userId: number): Promise<number> {
  const [rows] = await dbQuery<CountRow[]>(
    `SELECT COUNT(*) AS count FROM progress_photos WHERE user_id = ?`,
    [userId],
  )
  return rows[0].count
}

export async function getTotalStorageUsed(userId: number): Promise<number> {
  const [rows] = await dbQuery<TotalRow[]>(
    `SELECT SUM(file_size) AS total FROM progress_photos WHERE user_id = ?`,
    [userId],
  )
  return rows[0].total || 0
}

export async function getPhotosByDateRange(
  userId: number,
  startDate: string,
  endDate: string,
): Promise<PhotoMetadata[]> {
  const [rows] = await dbQuery<PhotoMetaRow[]>(
    `SELECT id, mime_type, file_size, taken_at, note, created_at FROM progress_photos WHERE user_id = ? AND DATE(taken_at) BETWEEN ? AND ? ORDER BY taken_at DESC`,
    [userId, startDate, endDate],
  )
  return rows.map(formatMeta)
}

export async function deleteAllPhotos(userId: number): Promise<number> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`DELETE FROM progress_photos WHERE user_id = ?`, [userId])
  return (result as unknown as InsertResult).affectedRows
}

function formatMeta(row: PhotoMetaRow): PhotoMetadata {
  return {
    id: row.id,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    takenAt: row.taken_at,
    note: row.note,
    createdAt: row.created_at,
    url: `/api/tracking/photos/${row.id}`,
  }
}
