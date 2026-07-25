// src/models/tracking/menstrual.ts
// Track menstrual cycle phases and symptoms

import { pool } from "../../config/database.js"
import { query as dbQuery } from "../../config/database.js"
import type { RowDataPacket } from "mysql2"
import type { InsertResult } from "../../types/index.js"
import { formatDateForMySQL } from "../utils/dateHelpers.js"
import { ValidationError } from "../../middleware/errorHandler.js"

export type FlowIntensity = "light" | "moderate" | "heavy"

export interface MenstrualEntry {
  id: number
  cycleStart: Date
  flowIntensity: FlowIntensity
  symptoms?: string[] | null
  createdAt: Date
  updatedAt: Date
}

export interface CyclePhase {
  phase: "menstruation" | "follicular" | "ovulation" | "luteal"
  daysInPhase: number
  estimatedEnd: Date
}

export interface CycleStats {
  currentPhase: CyclePhase | null
  averageCycleLength: number
  nextPeriodEstimate: Date | null
  lastCycleEntry: MenstrualEntry | null
  predictedPeriodDates: Date[]
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface MenstrualRow extends RowDataPacket {
  id: number
  cycle_start: Date
  cycle_end: Date | null
  duration_days: number | null
  flow_intensity: FlowIntensity
  symptoms: string | null
  created_at: Date
  updated_at: Date
}

interface AvgRow extends RowDataPacket {
  avg_cycle_length: number | null
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function logMenstrualCycle(
  userId: number,
  cycleStart: string,
  flowIntensity: FlowIntensity = "moderate",
  symptoms?: string[] | null,
): Promise<number> {
  const start = new Date(cycleStart)
  if (isNaN(start.getTime())) {
    throw new ValidationError("Invalid cycle start date")
  }

  if (!["light", "moderate", "heavy"].includes(flowIntensity)) {
    throw new ValidationError("Flow intensity must be: light, moderate, or heavy")
  }

  const symptomsJson = symptoms ? JSON.stringify(symptoms) : null

  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `INSERT INTO menstrual_cycle (user_id, cycle_start, flow_intensity, symptoms)
     VALUES (?, ?, ?, ?)`,
    [
      userId,
      formatDateForMySQL(cycleStart),
      flowIntensity,
      symptomsJson,
    ],
  )
  return (result as unknown as InsertResult).insertId
}

export async function endMenstrualCycle(
  userId: number,
  cycleId: number,
  cycleEnd: string,
): Promise<boolean> {
  const [check] = await dbQuery<MenstrualRow[]>(
    `SELECT cycle_start FROM menstrual_cycle WHERE id = ? AND user_id = ?`,
    [cycleId, userId],
  )
  if (!check[0]) {
    throw new ValidationError("Cycle not found")
  }

  const start = new Date(check[0].cycle_start)
  const end = new Date(cycleEnd)

  if (end <= start) {
    throw new ValidationError("Cycle end must be after cycle start")
  }

  const durationDays = Math.floor(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
  )

  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `UPDATE menstrual_cycle SET cycle_end = ?, duration_days = ? WHERE id = ? AND user_id = ?`,
    [formatDateForMySQL(cycleEnd), durationDays, cycleId, userId],
  )
  return (result as unknown as InsertResult).affectedRows > 0
}

export async function getMenstrualHistory(
  userId: number,
  limit = 12,
): Promise<MenstrualEntry[]> {
  const [rows] = await dbQuery<MenstrualRow[]>(
    `SELECT id, cycle_start, cycle_end, duration_days, flow_intensity, symptoms, created_at, updated_at
     FROM menstrual_cycle WHERE user_id = ? ORDER BY cycle_start DESC LIMIT ?`,
    [userId, limit],
  )
  return rows.map(formatEntry)
}

export async function getLastMenstrualCycle(
  userId: number,
): Promise<MenstrualEntry | null> {
  const [rows] = await dbQuery<MenstrualRow[]>(
    `SELECT id, cycle_start, cycle_end, duration_days, flow_intensity, symptoms, created_at, updated_at
     FROM menstrual_cycle WHERE user_id = ? ORDER BY cycle_start DESC LIMIT 1`,
    [userId],
  )
  return rows[0] ? formatEntry(rows[0]) : null
}

export async function getCycleStats(userId: number): Promise<CycleStats> {
  const last = await getLastMenstrualCycle(userId)

  // Calculate average cycle length from completed cycles
  const [avgRows] = await dbQuery<AvgRow[]>(
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
        estimatedEnd: new Date(cycleStartDate.getTime() + menstruationDays * 24 * 60 * 60 * 1000),
      }
    } else if (daysSinceStart <= menstruationDays + 7) {
      // follicular
      currentPhase = {
        phase: "follicular",
        daysInPhase: daysSinceStart - menstruationDays,
        estimatedEnd: new Date(cycleStartDate.getTime() + (menstruationDays + 7) * 24 * 60 * 60 * 1000),
      }
    } else if (daysSinceStart <= menstruationDays + 11) {
      // ovulation window
      currentPhase = {
        phase: "ovulation",
        daysInPhase: daysSinceStart - (menstruationDays + 7),
        estimatedEnd: new Date(cycleStartDate.getTime() + (menstruationDays + 11) * 24 * 60 * 60 * 1000),
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
    predictedPeriodDates: [],
  }
}

export async function deleteMenstrualEntry(
  userId: number,
  entryId: number,
): Promise<{ deleted: boolean; wasCycleStart: boolean }> {
  // Check whether this entry exists and whether it was a cycle start (i.e., cycle_start is set)
  const [check] = await dbQuery<MenstrualRow[]>(
    `SELECT id, cycle_start FROM menstrual_cycle WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  if (!check[0]) return { deleted: false, wasCycleStart: false }

  const wasCycleStart = !!check[0].cycle_start

  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `DELETE FROM menstrual_cycle WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  const deleted = (result as unknown as InsertResult).affectedRows > 0
  return { deleted, wasCycleStart }
}

// Menstrual settings stored per-user (period length, cycle length)
export interface MenstrualSettings {
  periodDays: number
  cycleLengthDays: number
  updatedAt: Date | null
}

export async function getMenstrualSettings(
  userId: number,
): Promise<MenstrualSettings> {
  const [rows] = await dbQuery<RowDataPacket[]>(
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
    `INSERT INTO menstrual_settings (user_id, period_days, cycle_length_days)
     VALUES (?, ?, ?)
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
    flowIntensity: row.flow_intensity,
    symptoms: row.symptoms ? JSON.parse(row.symptoms) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
