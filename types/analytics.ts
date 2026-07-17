/**
 * types/analytics.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Aggregated analytics result shapes (raw DB column names preserved).
 */

export interface AnalyticsSummary {
  avg_time_between_sets: number
  total_sessions: number
  total_sets: number
  total_volume: number
  avg_rest_time: number
  avg_set_duration: number
}

export interface ExerciseAnalytics {
  total_sets: number
  avg_weight: number
  max_weight: number
  avg_reps: number
  max_reps: number
  avg_duration: number
  avg_rest: number
}

export interface VolumeProgression {
  date: string
  total_volume: number
  sessions: number
  sets: number
}

export interface PersonalRecord {
  exercise_index: number
  max_weight: number
  max_reps: number
  max_volume: number
}

export interface WeeklySummaryDay {
  day_of_week: number
  sessions: number
  total_sets: number
  total_volume: number
}

export interface PeriodStats {
  sessions: number
  sets: number
  volume: number
}

export interface PeriodComparison {
  current: PeriodStats
  previous: PeriodStats
}
