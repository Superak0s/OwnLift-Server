import { pool, query as dbQuery } from "../../config/database.js"
import type { RowDataPacket } from "mysql2"
import { formatDateForMySQL } from "../utils/dateHelpers.js"
import type { InsertResult } from "../../types/index.js"
import { ValidationError } from "../../middleware/errorHandler.js"

export type FlowIntensity = "light" | "moderate" | "heavy"

interface DayFlowRow extends RowDataPacket {
  id: number
  user_id: number
  date: Date
  intensity: FlowIntensity
  note: string | null
  created_at: Date
  updated_at: Date
}

export interface DayFlowEntry {
  id: number
  date: string
  intensity: FlowIntensity
  note?: string | null
  createdAt: Date
  updatedAt: Date
}

export async function setDayFlow(
  userId: number,
  dateIso: string,
  intensity: FlowIntensity = "moderate",
  note?: string | null,
): Promise<void> {
  const d = new Date(dateIso)
  if (isNaN(d.getTime())) throw new ValidationError("Invalid date")
  if (!["light", "moderate", "heavy"].includes(intensity))
    throw new ValidationError("Invalid intensity value")

  await pool.execute(
    `INSERT INTO menstrual_day_flow (user_id, date, intensity, note) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE intensity = VALUES(intensity), note = VALUES(note), updated_at = NOW()`,
    [userId, formatDateForMySQL(dateIso).slice(0, 10), intensity, note || null],
  )
}

export async function getDayFlowForDate(
  userId: number,
  dateIso: string,
): Promise<DayFlowEntry | null> {
  const d = new Date(dateIso)
  if (isNaN(d.getTime())) throw new ValidationError("Invalid date")
  const [rows] = await dbQuery<DayFlowRow[]>(
    `SELECT id, date, intensity, note, created_at, updated_at FROM menstrual_day_flow WHERE user_id = ? AND date = ? LIMIT 1`,
    [userId, formatDateForMySQL(dateIso).slice(0, 10)],
  )
  if (!rows[0]) return null
  const r = rows[0]
  return {
    id: r.id,
    date: (r.date as Date).toISOString().slice(0, 10),
    intensity: r.intensity,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function deleteDayFlowForDate(
  userId: number,
  dateIso: string,
): Promise<boolean> {
  const d = new Date(dateIso)
  if (isNaN(d.getTime())) throw new ValidationError("Invalid date")
  const [result] = await pool.execute<InsertResult & { constructor: { name: string } }>(
    `DELETE FROM menstrual_day_flow WHERE user_id = ? AND date = ?`,
    [userId, formatDateForMySQL(dateIso).slice(0, 10)],
  )
  return (result as unknown as InsertResult).affectedRows > 0
}

export async function getDayFlowsForRange(
  userId: number,
  startIso: string,
  endIso: string,
): Promise<DayFlowEntry[]> {
  const start = new Date(startIso)
  const end = new Date(endIso)
  if (isNaN(start.getTime()) || isNaN(end.getTime()))
    throw new ValidationError("Invalid range dates")
  const [rows] = await dbQuery<DayFlowRow[]>(
    `SELECT id, date, intensity, note, created_at, updated_at FROM menstrual_day_flow WHERE user_id = ? AND date BETWEEN ? AND ?`,
    [userId, formatDateForMySQL(startIso).slice(0, 10), formatDateForMySQL(endIso).slice(0, 10)],
  )
  return rows.map((r) => ({
    id: r.id,
    date: (r.date as Date).toISOString().slice(0, 10),
    intensity: r.intensity,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}
