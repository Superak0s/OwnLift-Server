import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { ValidationError } from "@/middleware/errorHandler.js"

// Aliased to camelCase in SQL, so the query result is already the wire shape.
interface HydrationEntry extends RowDataPacket {
  id: number
  amountMl: number
  loggedAt: Date
  note: string | null
  createdAt: Date
}

export async function logHydration(
  userId: number,
  amountMl: number,
  loggedAt?: string | null,
  note?: string | null,
): Promise<number> {
  if (!Number.isFinite(amountMl) || amountMl <= 0) {
    throw new ValidationError("Hydration amount must be a number greater than 0 ml")
  }
  if (amountMl > 10000) {
    throw new ValidationError("Hydration amount seems unrealistic (max 10L)")
  }

  const ts = formatDateForMySQL(loggedAt ? loggedAt : new Date())
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO hydration_log (user_id, amount_ml, logged_at, note)
     VALUES (?, ?, ?, ?)`,
    [userId, amountMl, ts, note ?? null],
  )
  return result.insertId
}

export async function getHydrationHistory(
  userId: number,
  limit = 100,
): Promise<HydrationEntry[]> {
  const [rows] = await pool.execute<HydrationEntry[]>(
    `SELECT id, amount_ml AS amountMl, logged_at AS loggedAt, note,
            created_at AS createdAt
     FROM hydration_log WHERE user_id = ? ORDER BY logged_at DESC LIMIT ?`,
    [userId, limit],
  )
  return rows
}

export async function deleteHydrationEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM hydration_log WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  return result.affectedRows > 0
}

interface HydrationSettings {
  goalMl: number
  measurementErrorPercent: number
  updatedAt: Date | null
}

export async function getHydrationSettings(userId: number): Promise<HydrationSettings> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT goal_ml, measurement_error_percent, updated_at FROM hydration_settings WHERE user_id = ?`,
    [userId],
  )
  if (!rows[0]) {
    return { goalMl: 2000, measurementErrorPercent: 0, updatedAt: null }
  }
  return {
    goalMl: parseInt(String(rows[0].goal_ml)) || 2000,
    measurementErrorPercent: parseFloat(String(rows[0].measurement_error_percent)) || 0,
    updatedAt: rows[0].updated_at || null,
  }
}

export async function setHydrationSettings(userId: number, settings: Partial<{ goalMl: number; measurementErrorPercent: number }>): Promise<void> {
  const goal = settings.goalMl ?? null
  const err = settings.measurementErrorPercent ?? null
  await pool.execute(
    // COALESCE on insert: the client may send only one of the two, and the
    // columns are NOT NULL.
    `INSERT INTO hydration_settings (user_id, goal_ml, measurement_error_percent)
     VALUES (?, COALESCE(?, DEFAULT(goal_ml)), COALESCE(?, DEFAULT(measurement_error_percent)))
     ON DUPLICATE KEY UPDATE
       goal_ml = COALESCE(VALUES(goal_ml), goal_ml),
       measurement_error_percent = COALESCE(VALUES(measurement_error_percent), measurement_error_percent),
       updated_at = NOW()`,
    [userId, goal, err],
  )
}
