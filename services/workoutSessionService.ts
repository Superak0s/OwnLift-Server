// src/services/workoutSessionService.ts
import { pool } from "../config/database"
import { ValidationError } from "../middleware/errorHandler"
import {
  createSession,
  recordSetTiming,
  endSession,
  getSessionDetails,
  updateSessionPerson,
} from "../models/workout"
import type {
  SessionSummary,
  SessionProgress,
  ProgressionResult,
} from "../types"

export type { SessionSummary, SessionProgress, ProgressionResult }

// Maximum number of past sets fetched for progression detection.
const PROGRESSION_LOOKBACK = 10

// ─── Input shapes ─────────────────────────────────────────────────────────────

export interface StartSessionData {
  person?: string
  dayNumber: number
  dayTitle: string
  muscleGroups: string[]
  isAdmin?: boolean
  startTime?: string | null
}

export interface SetData {
  exerciseName: string
  setIndex: number
  startTime: string
  endTime: string
  weight?: number
  reps?: number
  note?: string | null
  isWarmup?: boolean
  muscleGroup?: string | null
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

export async function startWorkoutSession(
  userId: number,
  data: StartSessionData,
) {
  const { person, dayNumber, dayTitle, muscleGroups, isAdmin, startTime } = data
  if (!Array.isArray(muscleGroups) || muscleGroups.length === 0)
    throw new ValidationError("At least one muscle group is required")

  const sessionId = await createSession(
    userId,
    dayNumber,
    dayTitle,
    muscleGroups,
    isAdmin || false,
    startTime || null,
  )
  if (person) await updateSessionPerson(sessionId, userId, person)

  const session = await getSessionDetails(sessionId, userId)
  return { ...session, id: sessionId }
}

export async function recordWorkoutSet(
  sessionId: number,
  _userId: number,
  data: SetData,
) {
  const {
    exerciseName,
    setIndex,
    startTime,
    endTime,
    weight,
    reps,
    note,
    isWarmup,
    muscleGroup,
  } = data

  if (new Date(endTime) <= new Date(startTime))
    throw new ValidationError("End time must be after start time")

  return recordSetTiming(
    sessionId,
    exerciseName,
    setIndex,
    startTime,
    endTime,
    weight || 0,
    reps || 0,
    note || null,
    isWarmup || false,
    muscleGroup || null,
  )
}

export async function completeWorkoutSession(
  sessionId: number,
  userId: number,
) {
  const session = await endSession(sessionId)
  const details = await getSessionDetails(sessionId, userId)
  return { ...session, summary: calculateSessionSummary(details) }
}

// ─── Summary calculation ──────────────────────────────────────────────────────

export function calculateSessionSummary(session: {
  set_timings?: Array<{
    weight: number
    reps: number
    rest_time: number | null
    set_duration: number
    exercise_id: number
  }>
}): SessionSummary {
  const timings = session.set_timings || []
  if (!timings.length) {
    return {
      totalSets: 0,
      totalVolume: 0,
      averageRestTime: 0,
      averageSetDuration: 0,
      exerciseCount: 0,
    }
  }

  const totalSets = timings.length
  const totalVolume = timings.reduce((s, t) => s + t.weight * t.reps, 0)
  const withRest = timings.filter((t) => t.rest_time !== null)
  const averageRestTime =
    withRest.length > 0
      ? withRest.reduce((s, t) => s + (t.rest_time as number), 0) /
        withRest.length
      : 0
  const averageSetDuration =
    timings.reduce((s, t) => s + t.set_duration, 0) / totalSets

  return {
    totalSets,
    totalVolume: Math.round(totalVolume),
    averageRestTime: Math.round(averageRestTime),
    averageSetDuration: Math.round(averageSetDuration),
    exerciseCount: new Set(timings.map((t) => t.exercise_id)).size,
  }
}

// ─── Ownership check ──────────────────────────────────────────────────────────

export async function validateSessionOwnership(
  sessionId: number,
  userId: number,
): Promise<boolean> {
  const [rows] = await pool.execute<any[]>(
    "SELECT id FROM sessions WHERE id = ? AND user_id = ?",
    [sessionId, userId],
  )
  return rows.length > 0
}

// ─── Progress ─────────────────────────────────────────────────────────────────

export async function getSessionProgress(
  sessionId: number,
  userId: number,
  totalPlannedSets: number,
): Promise<SessionProgress> {
  const session = await getSessionDetails(sessionId, userId)
  const completedSets = session.set_timings?.length || 0
  return {
    completedSets,
    totalPlannedSets,
    percentage:
      totalPlannedSets > 0
        ? Math.round((completedSets / totalPlannedSets) * 100)
        : 0,
    remaining: Math.max(0, totalPlannedSets - completedSets),
  }
}

export async function getRestTimeRecommendation(
  sessionId: number,
  userId: number,
): Promise<number> {
  const session = await getSessionDetails(sessionId, userId)
  const restTimes = (session.set_timings || [])
    .filter((t) => t.rest_time !== null && t.rest_time > 0)
    .map((t) => t.rest_time as number)
  if (!restTimes.length) return 90
  return Math.round(restTimes.reduce((s, t) => s + t, 0) / restTimes.length)
}

// ─── Progression detection ────────────────────────────────────────────────────

export async function detectProgression(
  userId: number,
  exerciseId: number,
  dayNumber: number,
): Promise<ProgressionResult> {
  const [sets] = await pool.execute<any[]>(
    `SELECT st.weight, st.reps
     FROM set_timings st JOIN sessions s ON st.session_id = s.id
     WHERE s.user_id = ? AND st.exercise_id = ? AND s.day_number = ?
       AND s.is_admin = 0 AND st.is_warmup = 0
     ORDER BY s.start_time DESC LIMIT ?`,
    [userId, exerciseId, dayNumber, PROGRESSION_LOOKBACK],
  )

  if (sets.length < 2)
    return { hasProgression: false, message: "Not enough data" }

  const [latest, previous] = sets
  const latestVol = latest.weight * latest.reps
  const prevVol = previous.weight * previous.reps

  if (latestVol > prevVol)
    return {
      hasProgression: true,
      type: "volume",
      message: `Increased volume from ${prevVol} to ${latestVol}`,
      improvement: latestVol - prevVol,
    }
  if (latest.weight > previous.weight)
    return {
      hasProgression: true,
      type: "weight",
      message: `Increased weight from ${previous.weight} to ${latest.weight}`,
      improvement: latest.weight - previous.weight,
    }
  if (latest.reps > previous.reps)
    return {
      hasProgression: true,
      type: "reps",
      message: `Increased reps from ${previous.reps} to ${latest.reps}`,
      improvement: latest.reps - previous.reps,
    }

  return { hasProgression: false, message: "No progression detected" }
}
