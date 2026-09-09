// Track menstrual cycle phases and symptoms

import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { ValidationError } from "@/middleware/errorHandler.js"

interface MenstrualEntry {
  id: number
  cycleStart: Date
  durationDays: number | null
  symptoms?: string[] | null
  createdAt: Date
  updatedAt: Date
}

interface CyclePhase {
  phase: "menstruation" | "follicular" | "ovulation" | "luteal"
  daysInPhase: number
  estimatedEnd: Date
}

interface CycleStats {
  currentPhase: CyclePhase | null
  averageCycleLength: number
  nextPeriodEstimate: Date | null
  lastCycleEntry: MenstrualEntry | null
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface MenstrualRow extends RowDataPacket {
  id: number
  cycle_start: Date
  cycle_end: Date | null
  duration_days: number | null
  symptoms: string | null
  created_at: Date
  updated_at: Date
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function logMenstrualCycle(
  userId: number,
  cycleStart: string,
  symptoms?: string[] | null,
): Promise<number> {
  const start = new Date(cycleStart)
  if (isNaN(start.getTime())) {
    throw new ValidationError("Invalid cycle start date")
  }

  const symptomsJson = symptoms ? JSON.stringify(symptoms) : null

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO menstrual_cycle (user_id, cycle_start, symptoms)
     VALUES (?, ?, ?)`,
    [userId, formatDateForMySQL(cycleStart), symptomsJson],
  )
  return result.insertId
}

export async function getMenstrualHistory(
  userId: number,
  limit = 12,
): Promise<MenstrualEntry[]> {
  const [rows] = await pool.execute<MenstrualRow[]>(
    `SELECT id, cycle_start, cycle_end, duration_days, symptoms, created_at, updated_at
     FROM menstrual_cycle WHERE user_id = ? ORDER BY cycle_start DESC LIMIT ?`,
    [userId, limit],
  )
  return rows.map(formatEntry)
}

async function getLastMenstrualCycle(
  userId: number,
): Promise<MenstrualEntry | null> {
  const [rows] = await pool.execute<MenstrualRow[]>(
    `SELECT id, cycle_start, cycle_end, duration_days, symptoms, created_at, updated_at
     FROM menstrual_cycle WHERE user_id = ? ORDER BY cycle_start DESC LIMIT 1`,
    [userId],
  )
  return rows[0] ? formatEntry(rows[0]) : null
}

export async function getCycleStats(userId: number): Promise<CycleStats> {
  const last = await getLastMenstrualCycle(userId)

  // Calculate average cycle length from completed cycles
  const [avgRows] = await pool.execute<RowDataPacket[]>(
    `SELECT AVG(duration_days) AS avg_cycle_length FROM menstrual_cycle
     WHERE user_id = ? AND duration_days IS NOT NULL`,
    [userId],
  )
  const dbAvgCycleLength = avgRows[0]?.avg_cycle_length || null

  // Load user settings (may override defaults)
  const settings = await getMenstrualSettings(userId)
  const avgCycleLength = dbAvgCycleLength || settings.cycleLengthDays || 28
  const periodDays = settings.periodDays || 5

  let currentPhase: CyclePhase | null = null
  let nextPeriodEstimate: Date | null = null

  if (last) {
    const now = new Date()
    const cycleStartDate = new Date(last.cycleStart)
    const daysSinceStart = Math.floor(
      (now.getTime() - cycleStartDate.getTime()) / (1000 * 60 * 60 * 24),
    )

    // Estimate next period
    const nextPeriod = new Date(cycleStartDate)
    nextPeriod.setDate(nextPeriod.getDate() + Math.ceil(avgCycleLength))
    nextPeriodEstimate = nextPeriod

    // Determine current phase using configured periodDays and a simplified model
    const menstruationDays = periodDays
    if (daysSinceStart <= menstruationDays) {
      currentPhase = {
        phase: "menstruation",
        daysInPhase: daysSinceStart,
        estimatedEnd: new Date(
          cycleStartDate.getTime() + menstruationDays * 24 * 60 * 60 * 1000,
        ),
      }
    } else if (daysSinceStart <= menstruationDays + 7) {
      // follicular
      currentPhase = {
        phase: "follicular",
        daysInPhase: daysSinceStart - menstruationDays,
        estimatedEnd: new Date(
          cycleStartDate.getTime() +
            (menstruationDays + 7) * 24 * 60 * 60 * 1000,
        ),
      }
    } else if (daysSinceStart <= menstruationDays + 11) {
      // ovulation window
      currentPhase = {
        phase: "ovulation",
        daysInPhase: daysSinceStart - (menstruationDays + 7),
        estimatedEnd: new Date(
          cycleStartDate.getTime() +
            (menstruationDays + 11) * 24 * 60 * 60 * 1000,
        ),
      }
    } else {
      currentPhase = {
        phase: "luteal",
        daysInPhase: daysSinceStart - (menstruationDays + 11),
        estimatedEnd: new Date(nextPeriod),
      }
    }
  }

  return {
    currentPhase,
    averageCycleLength: Math.round(avgCycleLength),
    nextPeriodEstimate,
    lastCycleEntry: last,
  }
}

export async function deleteMenstrualEntry(
  userId: number,
  entryId: number,
): Promise<{ deleted: boolean; wasCycleStart: boolean }> {
  // Check whether this entry exists and whether it was a cycle start (i.e., cycle_start is set)
  const [check] = await pool.execute<MenstrualRow[]>(
    `SELECT id, cycle_start FROM menstrual_cycle WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  if (!check[0]) return { deleted: false, wasCycleStart: false }

  const wasCycleStart = !!check[0].cycle_start

  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM menstrual_cycle WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  const deleted = result.affectedRows > 0
  return { deleted, wasCycleStart }
}

// Menstrual settings stored per-user (period length, cycle length)
interface MenstrualSettings {
  periodDays: number
  cycleLengthDays: number
  updatedAt: Date | null
}

export async function getMenstrualSettings(
  userId: number,
): Promise<MenstrualSettings> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT period_days, cycle_length_days, updated_at FROM menstrual_settings WHERE user_id = ?`,
    [userId],
  )
  if (!rows[0]) {
    return { periodDays: 5, cycleLengthDays: 28, updatedAt: null }
  }
  return {
    periodDays: parseInt(String(rows[0].period_days)) || 5,
    cycleLengthDays: parseInt(String(rows[0].cycle_length_days)) || 28,
    updatedAt: rows[0].updated_at || null,
  }
}

export async function setMenstrualSettings(
  userId: number,
  settings: Partial<{ periodDays: number; cycleLengthDays: number }>,
): Promise<void> {
  const pd = settings.periodDays ?? null
  const cl = settings.cycleLengthDays ?? null
  await pool.execute(
    // COALESCE on insert: the client may send only one of the two, and the
    // columns are NOT NULL.
    `INSERT INTO menstrual_settings (user_id, period_days, cycle_length_days)
     VALUES (?, COALESCE(?, DEFAULT(period_days)), COALESCE(?, DEFAULT(cycle_length_days)))
     ON DUPLICATE KEY UPDATE
       period_days = COALESCE(VALUES(period_days), period_days),
       cycle_length_days = COALESCE(VALUES(cycle_length_days), cycle_length_days),
       updated_at = NOW()`,
    [userId, pd, cl],
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatEntry(row: MenstrualRow): MenstrualEntry {
  return {
    id: row.id,
    cycleStart: row.cycle_start,
    durationDays: row.duration_days,
    symptoms: row.symptoms ? JSON.parse(row.symptoms) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
