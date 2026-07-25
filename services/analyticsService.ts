// src/services/analyticsService.ts
//
// Presentation layer over models/analytics.ts.
// All SQL lives in the model — this file only adds camelCase reshaping,
// default-zero coalescing, and the "change" delta calculation.

import {
  getAnalytics,
  getExerciseAnalytics as modelExerciseAnalytics,
  getVolumeProgression as modelVolumeProgression,
  getPersonalRecords as modelPersonalRecords,
  getWeeklySummary as modelWeeklySummary,
  compareTimePeriods,
} from "../models/analytics.js"
import { getSessionStats } from "../models/workout.js"

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

// ─── Comprehensive analytics ──────────────────────────────────────────────────

export async function getComprehensiveAnalytics(
  userId: number,
  person: string | null = null,
  dayNumber: number | null = null,
) {
  const [analytics, stats] = await Promise.all([
    getAnalytics(userId, person, dayNumber),
    getSessionStats(userId, person, dayNumber),
  ])
  return {
    totalSessions: analytics.total_sessions || 0,
    totalSetsCompleted: analytics.total_sets || 0,
    averageTimeBetweenSets: analytics.avg_time_between_sets || 120,
    totalVolume: Math.round(analytics.total_volume || 0),
    averageRestTime: Math.round(analytics.avg_rest_time || 0),
    averageSetDuration: Math.round(analytics.avg_set_duration || 0),
    firstSession: stats.first_session,
    lastSession: stats.last_session,
  }
}

// ─── Volume progression ───────────────────────────────────────────────────────

export async function getVolumeProgression(userId: number, days = 30) {
  // days is clamped inside the model — no need to repeat the clamp here.
  const rows = await modelVolumeProgression(userId, days)
  return rows.map((r) => ({
    date: r.date,
    totalVolume: Math.round(r.total_volume || 0),
    sessions: r.sessions,
    sets: r.sets,
  }))
}

// ─── Exercise analytics ───────────────────────────────────────────────────────

export async function getExerciseAnalytics(
  userId: number,
  exerciseIndex: number,
  dayNumber: number,
) {
  const row = await modelExerciseAnalytics(userId, exerciseIndex, dayNumber)
  if (!row || row.total_sets === 0) return null
  return {
    totalSets: row.total_sets,
    averageWeight: Math.round(row.avg_weight || 0),
    maxWeight: Math.round(row.max_weight || 0),
    averageReps: Math.round(row.avg_reps || 0),
    averageDuration: Math.round(row.avg_duration || 0),
    averageRest: Math.round(row.avg_rest || 0),
  }
}

// ─── Weekly summary ───────────────────────────────────────────────────────────

export async function getWeeklySummary(userId: number) {
  const rows = await modelWeeklySummary(userId)
  return rows.map((r) => ({
    // day_of_week from DAYOFWEEK() is 1-indexed (1=Sunday). Guard the lookup
    // so an unexpected value returns "Unknown" rather than undefined.
    day: DAY_NAMES[(r.day_of_week - 1) % 7] ?? "Unknown",
    sessions: r.sessions,
    totalSets: r.total_sets,
    totalVolume: Math.round(r.total_volume || 0),
  }))
}

// ─── Personal records ─────────────────────────────────────────────────────────

export async function getPersonalRecords(
  userId: number,
  dayNumber: number | null = null,
) {
  const rows = await modelPersonalRecords(userId, dayNumber)
  return rows.map((r) => ({
    exerciseIndex: r.exercise_index,
    maxWeight: Math.round(r.max_weight || 0),
    maxReps: r.max_reps,
    maxVolume: Math.round(r.max_volume || 0),
  }))
}

// ─── Period comparison ────────────────────────────────────────────────────────

export async function comparePerformancePeriods(
  userId: number,
  period1Days = 7,
  period2Days = 14,
) {
  // Delegate validation to the model (it throws if period1 >= period2).
  const { current: curr, previous: prev } = await compareTimePeriods(
    userId,
    period1Days,
    period2Days,
  )
  const current = {
    sessions: curr.sessions || 0,
    sets: curr.sets || 0,
    volume: Math.round(curr.volume || 0),
  }
  const previous = {
    sessions: prev.sessions || 0,
    sets: prev.sets || 0,
    volume: Math.round(prev.volume || 0),
  }
  return {
    current,
    previous,
    change: {
      sessions: current.sessions - previous.sessions,
      sets: current.sets - previous.sets,
      volume: current.volume - previous.volume,
    },
  }
}
