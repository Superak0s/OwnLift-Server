// src/models/tracking/bodyStats.ts
// Body composition: weight tracking, body fat calculations & history.
// Height and weight-unit helpers are owned by user.ts and re-exported here.

import { pool } from "../../config/database"
import { query as dbQuery } from "../../config/database"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { InsertResult } from "../../types"
import { formatDateForMySQL } from "../utils/dateHelpers"
import type {
  WeightEntry,
  WeightStats,
  BodyFatEntry,
  BodyFatTrend,
  BodyFatTrendDirection,
} from "../../types"

export type { WeightEntry, WeightStats, BodyFatEntry, BodyFatTrend }

// Re-export height / weight-unit helpers from their canonical module
export {
  setUserHeight as setHeight,
  getUserHeight as getHeight,
  setWeightUnit,
  getWeightUnit,
} from "../user"

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface WeightEntryRow extends RowDataPacket {
  id: number
  weight_kg: number
  recorded_at: Date
  note: string | null
  created_at: Date
}

interface WeightStatsRow extends RowDataPacket {
  min_weight: number | null
  max_weight: number | null
  avg_weight: number | null
  entry_count: number
}

interface BodyFatRow extends RowDataPacket {
  id: number
  percentage: number
  waist_cm: number
  neck_cm: number
  hip_cm: number | null
  height_cm: number
  gender: string
  method: string
  calculated_at: Date
}


// ─── Body weight ──────────────────────────────────────────────────────────────

export async function logWeight(
  userId: number,
  weightKg: number,
  recordedAt?: string | null,
  note?: string | null,
): Promise<number> {
  const ts = formatDateForMySQL(recordedAt ? recordedAt : new Date())
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `INSERT INTO body_weight (user_id, weight_kg, recorded_at, note) VALUES (?, ?, ?, ?)`,
    [userId, weightKg, ts, note ?? null],
  )
  return (result as unknown as InsertResult).insertId
}

export async function getWeightHistory(
  userId: number,
  limit = 90,
): Promise<WeightEntry[]> {
  const [rows] = await dbQuery<WeightEntryRow[]>(
    `SELECT id, weight_kg, recorded_at, note, created_at FROM body_weight WHERE user_id = ? ORDER BY recorded_at DESC LIMIT ?`,
    [userId, limit],
  )
  return rows
}

export async function deleteWeightEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`DELETE FROM body_weight WHERE id = ? AND user_id = ?`, [entryId, userId])
  return (result as unknown as InsertResult).affectedRows > 0
}

export async function getCurrentWeight(
  userId: number,
): Promise<Pick<WeightEntry, "weight_kg" | "recorded_at"> | null> {
  const [rows] = await dbQuery<WeightEntryRow[]>(
    `SELECT weight_kg, recorded_at FROM body_weight WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 1`,
    [userId],
  )
  return rows[0] ?? null
}

export async function getWeightStats(
  userId: number,
  days = 30,
): Promise<WeightStats> {
  const [rows] = await dbQuery<WeightStatsRow[]>(
    `SELECT MIN(weight_kg) AS min_weight, MAX(weight_kg) AS max_weight, AVG(weight_kg) AS avg_weight, COUNT(*) AS entry_count
     FROM body_weight WHERE user_id = ? AND recorded_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [userId, days],
  )
  const stats = rows[0]
  const current = await getCurrentWeight(userId)
  return {
    minWeight: stats.min_weight,
    maxWeight: stats.max_weight,
    avgWeight: stats.avg_weight,
    currentWeight: current?.weight_kg ?? null,
    entryCount: stats.entry_count,
    change:
      current && stats.min_weight ? current.weight_kg - stats.min_weight : null,
  }
}

// ─── Body fat percentage (US Navy formula) ────────────────────────────────────

export function calculateBodyFatPercentage(
  gender: "male" | "female",
  heightCm: number,
  waistCm: number,
  neckCm: number,
  hipCm?: number | null,
): number {
  if (!heightCm || heightCm <= 0) throw new Error("Invalid height measurement")
  if (!waistCm || waistCm <= 0) throw new Error("Invalid waist measurement")
  if (!neckCm || neckCm <= 0) throw new Error("Invalid neck measurement")

  let bf: number
  if (gender === "male") {
    const diff = waistCm - neckCm
    if (diff <= 0) throw new Error("Waist must be greater than neck")
    bf =
      495 /
        (1.0324 - 0.19077 * Math.log10(diff) + 0.15456 * Math.log10(heightCm)) -
      450
  } else {
    if (!hipCm || hipCm <= 0)
      throw new Error("Hip measurement required for female calculation")
    const sum = waistCm + hipCm - neckCm
    if (sum <= 0) throw new Error("Waist + Hip must be greater than neck")
    bf =
      495 /
        (1.29579 - 0.35004 * Math.log10(sum) + 0.221 * Math.log10(heightCm)) -
      450
  }

  const result = parseFloat(bf.toFixed(1))
  if (isNaN(result) || result < 0 || result > 100)
    throw new Error(
      `Invalid body fat result: ${result}%. Check your measurements.`,
    )
  return result
}

export async function logBodyFat(
  userId: number,
  percentage: number,
  waistCm: number,
  neckCm: number,
  hipCm: number | null,
  heightCm: number,
  gender: string,
  calculatedAt: string | Date,
): Promise<BodyFatEntry> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `INSERT INTO body_fat_measurements (user_id, percentage, waist_cm, neck_cm, hip_cm, height_cm, gender, method, calculated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'us_navy', ?)`,
    [
      userId,
      percentage,
      waistCm,
      neckCm,
      hipCm,
      heightCm,
      gender,
      formatDateForMySQL(calculatedAt),
    ],
  )
  const [rows] = await pool.execute<BodyFatRow[]>(
    "SELECT * FROM body_fat_measurements WHERE id = ?",
    [(result as unknown as InsertResult).insertId],
  )
  return formatEntry(rows[0])
}

export async function getBodyFatHistory(
  userId: number,
  limit = 90,
): Promise<BodyFatEntry[]> {
  const [rows] = await pool.execute<BodyFatRow[]>(
    `SELECT * FROM body_fat_measurements WHERE user_id = ? ORDER BY calculated_at DESC LIMIT ?`,
    [userId, limit],
  )
  return rows.map(formatEntry)
}

export async function getLatestBodyFat(
  userId: number,
): Promise<BodyFatEntry | null> {
  const [rows] = await pool.execute<BodyFatRow[]>(
    `SELECT * FROM body_fat_measurements WHERE user_id = ? ORDER BY calculated_at DESC LIMIT 1`,
    [userId],
  )
  return rows[0] ? formatEntry(rows[0]) : null
}

export async function deleteBodyFatEntry(
  userId: number,
  entryId: number,
): Promise<boolean | null> {
  const [check] = await pool.execute<(RowDataPacket & { id: number })[]>(
    "SELECT id FROM body_fat_measurements WHERE id = ? AND user_id = ?",
    [entryId, userId],
  )
  if (!check[0]) return null
  const [result] = await pool.execute<ResultSetHeader>(
    "DELETE FROM body_fat_measurements WHERE id = ?",
    [entryId],
  )
  return (result as ResultSetHeader).affectedRows > 0
}

export async function getUserBodyData(
  userId: number,
): Promise<{ heightCm: number | null; gender: "male" | "female" } | null> {
  const [rows] = await pool.execute<any[]>(
    "SELECT height_cm, gender FROM users WHERE id = ?",
    [userId],
  )
  if (!rows[0]) return null
  return {
    heightCm: rows[0].height_cm ? parseFloat(rows[0].height_cm) : null,
    gender: rows[0].gender || "male",
  }
}

interface BodyFatTrendRow extends RowDataPacket {
  percentage: number
  calculated_at: Date
}

export async function getBodyFatTrend(
  userId: number,
  days = 90,
): Promise<BodyFatTrend> {
  const [entries] = await pool.execute<BodyFatTrendRow[]>(
    `SELECT percentage, calculated_at FROM body_fat_measurements
     WHERE user_id = ? AND calculated_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     ORDER BY calculated_at ASC`,
    [userId, days],
  )
  const data = entries.map((e) => ({
    percentage: e.percentage,
    date: e.calculated_at,
  }))
  if (entries.length < 2)
    return { trend: "insufficient_data", entries: entries.length, data }

  const first = entries[0].percentage
  const last = entries[entries.length - 1].percentage
  const change = last - first
  const changePercent = (change / first) * 100
  const daysDiff =
    (new Date(entries[entries.length - 1].calculated_at).getTime() -
      new Date(entries[0].calculated_at).getTime()) /
    (1000 * 60 * 60 * 24)
  const changePerWeek = daysDiff > 0 ? change / (daysDiff / 7) : 0
  const direction: BodyFatTrendDirection =
    Math.abs(changePercent) < 2
      ? "stable"
      : change < 0
        ? "decreasing"
        : "increasing"

  return {
    trend: {
      direction,
      totalChange: change,
      totalChangePercent: changePercent,
      changePerWeek,
      firstMeasurement: first,
      lastMeasurement: last,
      measurements: entries.length,
      timeSpan: daysDiff,
    },
    data,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatEntry(e: BodyFatRow): BodyFatEntry {
  return {
    id: e.id,
    percentage: e.percentage,
    measurements: {
      waist: e.waist_cm,
      neck: e.neck_cm,
      hip: e.hip_cm,
      height: e.height_cm,
      unit: "cm",
    },
    date: e.calculated_at,
    method: e.method,
    gender: e.gender,
  }
}
