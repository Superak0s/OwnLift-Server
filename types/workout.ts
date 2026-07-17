/**
 * types/workout.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Domain types for the workout-logging feature (the `sessions` table and its
 * per-set timing rows). Re-exported from types/index.ts so callers can keep
 * importing from "../types".
 */

export interface SetTiming {
  id: number
  session_id: number
  exercise_id: number
  exercise_name: string
  exercise_muscle_group: string | null
  set_index: number
  start_time: string
  end_time: string
  set_duration: number
  rest_time: number | null
  weight: number
  reps: number
  note: string | null
  is_warmup: number
}

export interface Session {
  id: number
  user_id: number
  day_number: number
  day_title: string
  muscle_groups: string[]
  start_time: string
  end_time: string | null
  total_duration: number | null
  completed_sets: number
  is_admin: number
  person: string | null
  user_name: string
  set_timings: SetTiming[]
}

export interface RecordSetResult {
  id: number
  exerciseId: number
  setDuration: number
  restTime: number | null
}

export interface SessionSummary {
  totalSets: number
  totalVolume: number
  averageRestTime: number
  averageSetDuration: number
  exerciseCount: number
}

export interface SessionProgress {
  completedSets: number
  totalPlannedSets: number
  percentage: number
  remaining: number
}
