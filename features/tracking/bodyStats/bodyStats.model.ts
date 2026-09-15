import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { WeightEntry, BodyFatEntry } from "../tracking.types.js"
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


export async function logWeight(
  userId: number,
  weightKg: number,
  recordedAt?: string | null,
  note?: string | null,
): Promise<number> {
  const ts = formatDateForMySQL(recordedAt ? recordedAt : new Date())
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO body_weight (user_id, weight_kg, recorded_at, note) VALUES (?, ?, ?, ?)`,
    [userId, weightKg, ts, note ?? null],
  )
  return result.insertId
}

export async function getWeightHistory(
  userId: number,
  limit = 90,
): Promise<WeightEntry[]> {
  const [rows] = await pool.execute<(WeightEntry & RowDataPacket)[]>(
    `SELECT id, weight_kg AS weightKg, recorded_at AS recordedAt, note, created_at AS createdAt
     FROM body_weight WHERE user_id = ? ORDER BY recorded_at DESC LIMIT ?`,
    [userId, limit],
  )
  return rows
}

export async function deleteWeightEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(`DELETE FROM body_weight WHERE id = ? AND user_id = ?`, [entryId, userId])
  return result.affectedRows > 0
}

export async function getCurrentWeight(
  userId: number,
): Promise<Pick<WeightEntry, "weightKg" | "recordedAt"> | null> {
  const [rows] = await pool.execute<(Pick<WeightEntry, "weightKg" | "recordedAt"> & RowDataPacket)[]>(
    `SELECT weight_kg AS weightKg, recorded_at AS recordedAt FROM body_weight WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 1`,
    [userId],
  )
  return rows[0] ?? null
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
  heightCm: number | null,
  gender: string,
  calculatedAt: string | Date,
): Promise<BodyFatEntry> {
  const [result] = await pool.execute<ResultSetHeader>(
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
    [result.insertId],
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

export async function deleteBodyFatEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    "DELETE FROM body_fat_measurements WHERE id = ? AND user_id = ?",
    [entryId, userId],
  )
  return result.affectedRows > 0
}

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
