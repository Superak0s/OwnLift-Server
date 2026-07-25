// src/models/tracking/sleep.ts
// Track sleep duration and quality

import { pool } from "../../config/database"
import { query as dbQuery } from "../../config/database"
import type { RowDataPacket } from "mysql2"
import type { InsertResult } from "../../types"
import { formatDateForMySQL } from "../utils/dateHelpers"
import { ValidationError } from "../../middleware/errorHandler"

export type SleepQuality = "poor" | "fair" | "good" | "excellent"

export interface SleepEntry {
  id: number
  bedtime: Date
  wakeTime: Date
  durationHours: number
  quality: SleepQuality
  note?: string | null
  createdAt: Date
}

export interface SleepStats {
  averageDuration: number
  totalNights: number
  bestQuality: SleepQuality | null
  qualityCounts: Record<SleepQuality, number>
  lastEntry: SleepEntry | null
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface SleepRow extends RowDataPacket {
  id: number
  bedtime: Date
  wake_time: Date
  duration_hours: number | null
  quality: SleepQuality
  note: string | null
  created_at: Date
}

interface AvgRow extends RowDataPacket {
  avg_duration: number | null
  total_nights: number
}

interface QualityRow extends RowDataPacket {
  quality: SleepQuality
  count: number
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function logSleep(
  userId: number,
  bedtime: string,
  wakeTime: string,
  quality: SleepQuality = "good",
  note?: string | null,
): Promise<number> {
  const bed = new Date(bedtime)
  const wake = new Date(wakeTime)

  if (bed >= wake) {
    throw new ValidationError("Bedtime must be before wake time")
  }

  const durationMs = wake.getTime() - bed.getTime()
  const durationHours = durationMs / (1000 * 60 * 60)

  if (durationHours < 0.5 || durationHours > 24) {
    throw new ValidationError("Sleep duration should be between 0.5 and 24 hours")
  }

  if (!["poor", "fair", "good", "excellent"].includes(quality)) {
    throw new ValidationError(
      "Quality must be one of: poor, fair, good, excellent",
    )
  }

  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `INSERT INTO sleep_log (user_id, bedtime, wake_time, duration_hours, quality, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      formatDateForMySQL(bedtime),
      formatDateForMySQL(wakeTime),
      parseFloat(durationHours.toFixed(2)),
      quality,
      note ?? null,
    ],
  )
  return (result as unknown as InsertResult).insertId
}

export async function getSleepHistory(
  userId: number,
  limit = 90,
): Promise<SleepEntry[]> {
  const [rows] = await dbQuery<SleepRow[]>(
    `SELECT id, bedtime, wake_time, duration_hours, quality, note, created_at
     FROM sleep_log WHERE user_id = ? ORDER BY bedtime DESC LIMIT ?`,
    [userId, limit],
  )
  return rows.map(formatEntry)
}

export async function getSleepStats(
  userId: number,
  days = 30,
): Promise<SleepStats> {
  // Average duration and count
  const [avgRows] = await dbQuery<AvgRow[]>(
    `SELECT AVG(duration_hours) AS avg_duration, COUNT(*) AS total_nights
     FROM sleep_log WHERE user_id = ? AND bedtime >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [userId, days],
  )
  const avgStats = avgRows[0]

  // Quality breakdown
  const [qualityRows] = await dbQuery<QualityRow[]>(
    `SELECT quality, COUNT(*) AS count FROM sleep_log
     WHERE user_id = ? AND bedtime >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY quality`,
    [userId, days],
  )

  const qualityCounts: Record<SleepQuality, number> = {
    poor: 0,
    fair: 0,
    good: 0,
    excellent: 0,
  }
  let bestQuality: SleepQuality | null = null
  let maxCount = 0

  for (const row of qualityRows) {
    qualityCounts[row.quality] = row.count
    if (row.count > maxCount) {
      maxCount = row.count
      bestQuality = row.quality
    }
  }

  const lastEntry = await getLastSleepEntry(userId)

  return {
    averageDuration: parseFloat((avgStats.avg_duration || 0).toFixed(1)),
    totalNights: avgStats.total_nights,
    bestQuality,
    qualityCounts,
    lastEntry,
  }
}

export async function deleteSleepEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `DELETE FROM sleep_log WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  return (result as unknown as InsertResult).affectedRows > 0
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getLastSleepEntry(userId: number): Promise<SleepEntry | null> {
  const [rows] = await dbQuery<SleepRow[]>(
    `SELECT id, bedtime, wake_time, duration_hours, quality, note, created_at
     FROM sleep_log WHERE user_id = ? ORDER BY bedtime DESC LIMIT 1`,
    [userId],
  )
  return rows[0] ? formatEntry(rows[0]) : null
}

function formatEntry(row: SleepRow): SleepEntry {
  return {
    id: row.id,
    bedtime: row.bedtime,
    wakeTime: row.wake_time,
    durationHours: row.duration_hours || 0,
    quality: row.quality,
    note: row.note,
    createdAt: row.created_at,
  }
}
