// src/models/tracking/bodyMeasurements.ts
// Track body circumference measurements: waist, arms, chest

import { pool } from "../../config/database.js"
import { query as dbQuery } from "../../config/database.js"
import type { RowDataPacket } from "mysql2"
import type { InsertResult } from "../../types/index.js"
import { formatDateForMySQL } from "../utils/dateHelpers.js"
import { NotFoundError, ValidationError } from "../../middleware/errorHandler.js"

export interface MeasurementEntry {
  id: number
  waistCm?: number | null
  armLeftCm?: number | null
  armRightCm?: number | null
  chestCm?: number | null
  measuredAt: Date
  note?: string | null
  createdAt: Date
}

export interface MeasurementStats {
  current: Partial<MeasurementEntry> | null
  minWaist: number | null
  maxWaist: number | null
  minChest: number | null
  maxChest: number | null
  minArmLeft: number | null
  maxArmLeft: number | null
  entryCount: number
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface MeasurementRow extends RowDataPacket {
  id: number
  waist_cm: number | null
  arm_left_cm: number | null
  arm_right_cm: number | null
  chest_cm: number | null
  measured_at: Date
  note: string | null
  created_at: Date
}

interface StatsRow extends RowDataPacket {
  min_waist: number | null
  max_waist: number | null
  min_chest: number | null
  max_chest: number | null
  min_arm_left: number | null
  max_arm_left: number | null
  entry_count: number
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function logMeasurement(
  userId: number,
  waistCm?: number | null,
  armLeftCm?: number | null,
  armRightCm?: number | null,
  chestCm?: number | null,
  measuredAt?: string | null,
  note?: string | null,
): Promise<number> {
  // At least one measurement is required
  if (!waistCm && !armLeftCm && !armRightCm && !chestCm) {
    throw new ValidationError(
      "At least one body measurement (waist, arms, or chest) is required",
    )
  }

  // Validate measurements are positive
  if (waistCm && waistCm <= 0)
    throw new ValidationError("Waist measurement must be positive")
  if (armLeftCm && armLeftCm <= 0)
    throw new ValidationError("Left arm measurement must be positive")
  if (armRightCm && armRightCm <= 0)
    throw new ValidationError("Right arm measurement must be positive")
  if (chestCm && chestCm <= 0)
    throw new ValidationError("Chest measurement must be positive")

  const ts = formatDateForMySQL(measuredAt ? measuredAt : new Date())
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
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
  return (result as unknown as InsertResult).insertId
}

export async function getMeasurementHistory(
  userId: number,
  limit = 90,
): Promise<MeasurementEntry[]> {
  const [rows] = await dbQuery<MeasurementRow[]>(
    `SELECT id, waist_cm, arm_left_cm, arm_right_cm, chest_cm, measured_at, note, created_at
     FROM body_measurements WHERE user_id = ? ORDER BY measured_at DESC LIMIT ?`,
    [userId, limit],
  )
  return rows.map(formatEntry)
}

export async function getLatestMeasurement(
  userId: number,
): Promise<MeasurementEntry | null> {
  const [rows] = await dbQuery<MeasurementRow[]>(
    `SELECT id, waist_cm, arm_left_cm, arm_right_cm, chest_cm, measured_at, note, created_at
     FROM body_measurements WHERE user_id = ? ORDER BY measured_at DESC LIMIT 1`,
    [userId],
  )
  return rows[0] ? formatEntry(rows[0]) : null
}

export async function getMeasurementStats(
  userId: number,
  days = 90,
): Promise<MeasurementStats> {
  const [rows] = await dbQuery<StatsRow[]>(
    `SELECT
       MIN(waist_cm) AS min_waist, MAX(waist_cm) AS max_waist,
       MIN(chest_cm) AS min_chest, MAX(chest_cm) AS max_chest,
       MIN(arm_left_cm) AS min_arm_left, MAX(arm_left_cm) AS max_arm_left,
       COUNT(*) AS entry_count
     FROM body_measurements WHERE user_id = ? AND measured_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [userId, days],
  )
  const stats = rows[0]
  const current = await getLatestMeasurement(userId)

  return {
    current,
    minWaist: stats.min_waist,
    maxWaist: stats.max_waist,
    minChest: stats.min_chest,
    maxChest: stats.max_chest,
    minArmLeft: stats.min_arm_left,
    maxArmLeft: stats.max_arm_left,
    entryCount: stats.entry_count,
  }
}

export async function deleteMeasurementEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `DELETE FROM body_measurements WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  return (result as unknown as InsertResult).affectedRows > 0
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatEntry(row: MeasurementRow): MeasurementEntry {
  return {
    id: row.id,
    waistCm: row.waist_cm,
    armLeftCm: row.arm_left_cm,
    armRightCm: row.arm_right_cm,
    chestCm: row.chest_cm,
    measuredAt: row.measured_at,
    note: row.note,
    createdAt: row.created_at,
  }
}
