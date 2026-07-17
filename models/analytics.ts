// src/models/analytics.ts
import type { RowDataPacket } from "mysql2"
import { query as dbQuery } from "../config/database"
import type {
  AnalyticsSummary,
  ExerciseAnalytics,
  VolumeProgression,
  PersonalRecord,
  WeeklySummaryDay,
  PeriodComparison,
  PeriodStats,
} from "../types"

export type {
  AnalyticsSummary,
  ExerciseAnalytics,
  VolumeProgression,
  PersonalRecord,
  WeeklySummaryDay,
  PeriodComparison,
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface AnalyticsSummaryRow extends RowDataPacket {
  avg_time_between_sets: number
  total_sessions: number
  total_sets: number
  total_volume: number
  avg_rest_time: number
  avg_set_duration: number
}

interface ExerciseAnalyticsRow extends RowDataPacket {
  total_sets: number
  avg_weight: number
  max_weight: number
  avg_reps: number
  max_reps: number
  avg_duration: number
  avg_rest: number
}

interface VolumeProgressionRow extends RowDataPacket {
  date: string
  total_volume: number
  sessions: number
  sets: number
}

interface PersonalRecordRow extends RowDataPacket {
  exercise_index: number
  max_weight: number
  max_reps: number
  max_volume: number
}

interface WeeklySummaryDayRow extends RowDataPacket {
  day_of_week: number
  sessions: number
  total_sets: number
  total_volume: number
}

interface PeriodStatsRow extends RowDataPacket {
  sessions: number
  sets: number
  volume: number
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function getAnalytics(
  userId: number,
  person?: string | null,
  dayNumber?: number | null,
): Promise<AnalyticsSummary> {
  let q = `
    SELECT
      COALESCE(ROUND(AVG(st.set_duration + COALESCE(st.rest_time, 0))), 120) AS avg_time_between_sets,
      COUNT(DISTINCT s.id) AS total_sessions,
      COUNT(st.id) AS total_sets,
      COALESCE(SUM(st.weight * st.reps), 0) AS total_volume,
      COALESCE(ROUND(AVG(st.rest_time)), 0) AS avg_rest_time,
      COALESCE(ROUND(AVG(st.set_duration)), 0) AS avg_set_duration
    FROM sessions s
    LEFT JOIN set_timings st ON s.id = st.session_id
    WHERE s.user_id = ? AND s.is_admin = 0 AND s.end_time IS NOT NULL`
  const params: unknown[] = [userId]
  if (person) {
    q += ` AND s.person = ?`
    params.push(person)
  }
  // Use != null so dayNumber = 0 is still applied (falsy check would skip it)
  if (dayNumber != null) {
    q += ` AND s.day_number = ?`
    params.push(dayNumber)
  }
  const [rows] = await dbQuery<AnalyticsSummaryRow[]>(q, params)
  return rows[0]
}

export async function getExerciseAnalytics(
  userId: number,
  exerciseIndex: number,
  dayNumber?: number | null,
): Promise<ExerciseAnalytics> {
  let q = `
    SELECT COUNT(st.id) AS total_sets, AVG(st.weight) AS avg_weight, MAX(st.weight) AS max_weight,
      AVG(st.reps) AS avg_reps, MAX(st.reps) AS max_reps, AVG(st.set_duration) AS avg_duration, AVG(st.rest_time) AS avg_rest
    FROM set_timings st JOIN sessions s ON st.session_id = s.id
    WHERE s.user_id = ? AND st.exercise_index = ? AND s.is_admin = 0 AND s.end_time IS NOT NULL AND st.is_warmup = 0`
  const params: unknown[] = [userId, exerciseIndex]
  if (dayNumber != null) {
    q += ` AND s.day_number = ?`
    params.push(dayNumber)
  }
  const [rows] = await dbQuery<ExerciseAnalyticsRow[]>(q, params)
  return rows[0]
}

export async function getVolumeProgression(
  userId: number,
  days = 30,
): Promise<VolumeProgression[]> {
  const [rows] = await dbQuery<VolumeProgressionRow[]>(
    `SELECT DATE(s.start_time) AS date, SUM(st.weight * st.reps) AS total_volume,
       COUNT(DISTINCT s.id) AS sessions, COUNT(st.id) AS sets
     FROM sessions s LEFT JOIN set_timings st ON s.id = st.session_id
     WHERE s.user_id = ? AND s.is_admin = 0 AND s.end_time IS NOT NULL
       AND s.start_time >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY DATE(s.start_time) ORDER BY date ASC`,
    [userId, days],
  )
  return rows
}

export async function getPersonalRecords(
  userId: number,
  dayNumber?: number | null,
): Promise<PersonalRecord[]> {
  let q = `
    SELECT st.exercise_index, MAX(st.weight) AS max_weight, MAX(st.reps) AS max_reps,
      MAX(st.weight * st.reps) AS max_volume
    FROM set_timings st JOIN sessions s ON st.session_id = s.id
    WHERE s.user_id = ? AND s.is_admin = 0 AND st.is_warmup = 0`
  const params: unknown[] = [userId]
  if (dayNumber != null) {
    q += ` AND s.day_number = ?`
    params.push(dayNumber)
  }
  q += ` GROUP BY st.exercise_index`
  const [rows] = await dbQuery<PersonalRecordRow[]>(q, params)
  return rows
}

export async function getWeeklySummary(
  userId: number,
): Promise<WeeklySummaryDay[]> {
  const [rows] = await dbQuery<WeeklySummaryDayRow[]>(
    `SELECT DAYOFWEEK(s.start_time) AS day_of_week, COUNT(DISTINCT s.id) AS sessions,
       COUNT(st.id) AS total_sets, SUM(st.weight * st.reps) AS total_volume
     FROM sessions s LEFT JOIN set_timings st ON s.id = st.session_id
     WHERE s.user_id = ? AND s.is_admin = 0 AND s.end_time IS NOT NULL
       AND s.start_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
     GROUP BY DAYOFWEEK(s.start_time) ORDER BY day_of_week`,
    [userId],
  )
  return rows
}

export async function compareTimePeriods(
  userId: number,
  period1Days = 7,
  period2Days = 14,
): Promise<PeriodComparison> {
  const base = (extraWhere = "") =>
    `SELECT COUNT(DISTINCT s.id) AS sessions, COUNT(st.id) AS sets, SUM(st.weight * st.reps) AS volume
     FROM sessions s LEFT JOIN set_timings st ON s.id = st.session_id
     WHERE s.user_id = ? AND s.is_admin = 0 AND s.end_time IS NOT NULL
       AND s.start_time >= DATE_SUB(NOW(), INTERVAL ? DAY)${extraWhere}`

  const [[current], [previous]] = await Promise.all([
    dbQuery<PeriodStatsRow[]>(base(), [userId, period1Days]),
    dbQuery<PeriodStatsRow[]>(
      base(" AND s.start_time < DATE_SUB(NOW(), INTERVAL ? DAY)"),
      [userId, period2Days, period1Days],
    ),
  ])
  return {
    current: current[0] as PeriodStats,
    previous: previous[0] as PeriodStats,
  }
}
