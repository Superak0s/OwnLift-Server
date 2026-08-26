import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { ValidationError } from "@/middleware/errorHandler.js"

// Aliased to camelCase in SQL, so the query result is already the wire shape.
interface MeasurementEntry extends RowDataPacket {
  id: number
  waistCm: number | null
  armLeftCm: number | null
  armRightCm: number | null
  chestCm: number | null
  measuredAt: Date
  note: string | null
  createdAt: Date
}

export async function logMeasurement(
  userId: number,
  waistCm?: number | null,
  armLeftCm?: number | null,
  armRightCm?: number | null,
  chestCm?: number | null,
  measuredAt?: string | null,
  note?: string | null,
): Promise<number> {
  if (!waistCm && !armLeftCm && !armRightCm && !chestCm) {
    throw new ValidationError(
      "At least one body measurement (waist, arms, or chest) is required",
    )
  }

  if (waistCm && waistCm <= 0)
    throw new ValidationError("Waist measurement must be positive")
  if (armLeftCm && armLeftCm <= 0)
    throw new ValidationError("Left arm measurement must be positive")
  if (armRightCm && armRightCm <= 0)
    throw new ValidationError("Right arm measurement must be positive")
  if (chestCm && chestCm <= 0)
    throw new ValidationError("Chest measurement must be positive")

  const ts = formatDateForMySQL(measuredAt ? measuredAt : new Date())
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO body_measurements (user_id, waist_cm, arm_left_cm, arm_right_cm, chest_cm, measured_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      waistCm ?? null,
      armLeftCm ?? null,
      armRightCm ?? null,
      chestCm ?? null,
      ts,
      note ?? null,
    ],
  )
  return result.insertId
}

export async function getMeasurementHistory(
  userId: number,
  limit = 90,
): Promise<MeasurementEntry[]> {
  const [rows] = await pool.execute<MeasurementEntry[]>(
    `SELECT id, waist_cm AS waistCm, arm_left_cm AS armLeftCm,
            arm_right_cm AS armRightCm, chest_cm AS chestCm,
            measured_at AS measuredAt, note, created_at AS createdAt
     FROM body_measurements WHERE user_id = ? ORDER BY measured_at DESC LIMIT ?`,
    [userId, limit],
  )
  return rows
}

export async function deleteMeasurementEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM body_measurements WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  return result.affectedRows > 0
}
