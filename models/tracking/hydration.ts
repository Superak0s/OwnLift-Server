// src/models/tracking/hydration.ts
// Track daily water intake

import { pool } from "../../config/database"
import { query as dbQuery } from "../../config/database"
import type { RowDataPacket } from "mysql2"
import type { InsertResult } from "../../types"
import { formatDateForMySQL } from "../utils/dateHelpers"
import { ValidationError } from "../../middleware/errorHandler"

export interface HydrationEntry {
  id: number
  amountMl: number
  loggedAt: Date
  note?: string | null
  createdAt: Date
}

export interface HydrationStats {
  totalToday: number
  totalThisWeek: number
  totalThisMonth: number
  averageDaily: number
  entryCount: number
  lastEntry: HydrationEntry | null
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface HydrationRow extends RowDataPacket {
  id: number
  amount_ml: number
  logged_at: Date
  note: string | null
  created_at: Date
}

interface TotalRow extends RowDataPacket {
  total: number | null
  count: number
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function logHydration(
  userId: number,
  amountMl: number,
  loggedAt?: string | null,
  note?: string | null,
): Promise<number> {
  if (amountMl <= 0) {
    throw new ValidationError("Hydration amount must be greater than 0 ml")
  }
  if (amountMl > 10000) {
    throw new ValidationError("Hydration amount seems unrealistic (max 10L)")
  }

  const ts = formatDateForMySQL(loggedAt ? loggedAt : new Date())
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `INSERT INTO hydration_log (user_id, amount_ml, logged_at, note)
     VALUES (?, ?, ?, ?)`,
    [userId, amountMl, ts, note ?? null],
  )
  return (result as unknown as InsertResult).insertId
}

export async function getHydrationHistory(
  userId: number,
  limit = 100,
): Promise<HydrationEntry[]> {
  const [rows] = await dbQuery<HydrationRow[]>(
    `SELECT id, amount_ml, logged_at, note, created_at
     FROM hydration_log WHERE user_id = ? ORDER BY logged_at DESC LIMIT ?`,
    [userId, limit],
  )
  return rows.map(formatEntry)
}

export async function getDailyHydration(
  userId: number,
  date: string,
): Promise<HydrationEntry[]> {
  const [rows] = await dbQuery<HydrationRow[]>(
    `SELECT id, amount_ml, logged_at, note, created_at
     FROM hydration_log WHERE user_id = ? AND DATE(logged_at) = ? ORDER BY logged_at DESC`,
    [userId, date],
  )
  return rows.map(formatEntry)
}

export async function getHydrationStats(userId: number): Promise<HydrationStats> {
  // Today's total
  const [todayRows] = await dbQuery<TotalRow[]>(
    `SELECT SUM(amount_ml) AS total, COUNT(*) AS count
     FROM hydration_log WHERE user_id = ? AND DATE(logged_at) = CURDATE()`,
    [userId],
  )
  const today = todayRows[0]

  // This week
  const [weekRows] = await dbQuery<TotalRow[]>(
    `SELECT SUM(amount_ml) AS total FROM hydration_log
     WHERE user_id = ? AND logged_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    [userId],
  )

  // This month
  const [monthRows] = await dbQuery<TotalRow[]>(
    `SELECT SUM(amount_ml) AS total FROM hydration_log
     WHERE user_id = ? AND MONTH(logged_at) = MONTH(NOW()) AND YEAR(logged_at) = YEAR(NOW())`,
    [userId],
  )

  // Average daily (last 30 days)
  const [avgRows] = await dbQuery<TotalRow[]>(
    `SELECT SUM(amount_ml) AS total, COUNT(DISTINCT DATE(logged_at)) AS count
     FROM hydration_log WHERE user_id = ? AND logged_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    [userId],
  )
  const avgDaily =
    avgRows[0].count > 0
      ? (avgRows[0].total || 0) / avgRows[0].count
      : 0

  const lastEntry = await getLastHydrationEntry(userId)

  return {
    totalToday: today.total || 0,
    totalThisWeek: weekRows[0].total || 0,
    totalThisMonth: monthRows[0].total || 0,
    averageDaily: parseFloat(avgDaily.toFixed(0)),
    entryCount: today.count,
    lastEntry,
  }
}

export async function deleteHydrationEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `DELETE FROM hydration_log WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  return (result as unknown as InsertResult).affectedRows > 0
}

// Hydration settings stored per-user (goal ml and measurement error %)
export interface HydrationSettings {
  goalMl: number
  measurementErrorPercent: number
  updatedAt: Date | null
}

export async function getHydrationSettings(userId: number): Promise<HydrationSettings> {
  const [rows] = await dbQuery<RowDataPacket[]>(
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
    `INSERT INTO hydration_settings (user_id, goal_ml, measurement_error_percent)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       goal_ml = COALESCE(VALUES(goal_ml), goal_ml),
       measurement_error_percent = COALESCE(VALUES(measurement_error_percent), measurement_error_percent),
       updated_at = NOW()`,
    [userId, goal, err],
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getLastHydrationEntry(
  userId: number,
): Promise<HydrationEntry | null> {
  const [rows] = await dbQuery<HydrationRow[]>(
    `SELECT id, amount_ml, logged_at, note, created_at
     FROM hydration_log WHERE user_id = ? ORDER BY logged_at DESC LIMIT 1`,
    [userId],
  )
  return rows[0] ? formatEntry(rows[0]) : null
}

function formatEntry(row: HydrationRow): HydrationEntry {
  return {
    id: row.id,
    amountMl: row.amount_ml,
    loggedAt: row.logged_at,
    note: row.note,
    createdAt: row.created_at,
  }
}
