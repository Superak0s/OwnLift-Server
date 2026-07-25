// src/models/workout.ts
import { pool } from "../config/database.js"
import { query as dbQuery } from "../config/database.js"
import type { RowDataPacket } from "mysql2"
import { formatDateForMySQL } from "./utils/dateHelpers.js"
import { NotFoundError, ForbiddenError } from "../middleware/errorHandler.js"
import type {
  SetTiming,
  Session,
  RecordSetResult,
  InsertResult,
} from "../types/index.js"

export type { SetTiming, Session, RecordSetResult }

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface SessionRow extends RowDataPacket {
  id: number
  user_id: number
  day_number: number
  day_title: string
  // JSON column — mysql2 auto-parses this to string[] for most rows, but
  // some legacy rows hold a plain comma-joined string. See parseMuscleGroups.
  muscle_groups: string | string[]
  start_time: Date | string
  end_time: Date | string | null
  total_duration: number | null
  completed_sets: number
  is_admin: number
  person: string | null
  user_name: string
  username: string
  set_count?: number
}

interface SetTimingRow extends RowDataPacket {
  id: number
  session_id: number
  exercise_id: number
  exercise_name: string
  exercise_muscle_group: string | null
  set_index: number
  start_time: Date | string
  end_time: Date | string
  set_duration: number
  rest_time: number | null
  weight: number
  reps: number
  note: string | null
  is_warmup: number
}

interface LastSetRow extends RowDataPacket {
  end_time: Date | string
}

interface ExerciseIdRow extends RowDataPacket {
  id: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripDates<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row }
  for (const f of ["start_time", "end_time", "created_at"] as const) {
    if (out[f] instanceof Date) {
      ;(out as Record<string, unknown>)[f] = (out[f] as Date)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ")
    }
  }
  return out
}

/**
 * Parse the `sessions.muscle_groups` column into a string[].
 *
 * `muscle_groups` is a MySQL JSON column, and mysql2 auto-parses JSON-typed
 * columns for you — so most rows arrive here as an actual array already,
 * not a string. Some older rows apparently hold a plain comma-joined string
 * instead (e.g. "Glutes,Hamstrings"), predating whatever migration/version
 * put this column on JSON.stringify'd data.
 *
 * This handles all three shapes that can show up: an array (the common
 * case — already parsed by the driver), a JSON-encoded string (in case a
 * connection/config ever returns JSON columns as raw text instead), or a
 * legacy comma-joined string. Anything else (null, empty, unexpected type)
 * becomes [].
 */
export function parseMuscleGroups(raw: unknown): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) {
    return raw.filter((g): g is string => typeof g === "string")
  }
  if (typeof raw !== "string" || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return raw
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean)
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function findOrCreateExercise(
  name: string,
  muscleGroup: string | null = null,
): Promise<number> {
  // Use LAST_INSERT_ID trick to get the id atomically whether this is an
  // insert or a duplicate-key no-op. Avoids the INSERT IGNORE + SELECT race
  // where two concurrent requests for the same new exercise could both see
  // 0 rows from the follow-up SELECT.
  await pool.execute(
    `INSERT INTO exercises (name, muscle_group) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [name, muscleGroup],
  )
  const [rows] = await pool.execute<ExerciseIdRow[]>(
    `SELECT LAST_INSERT_ID() AS id`,
  )
  return rows[0].id
}

export async function createSession(
  userId: number,
  dayNumber: number,
  dayTitle: string,
  muscleGroups: string[],
  isAdmin = false,
  startTime: string | Date | null = null,
): Promise<number> {
  const ts = formatDateForMySQL(startTime ? startTime : new Date())
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `INSERT INTO sessions (user_id, day_number, day_title, muscle_groups, start_time, is_admin) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      dayNumber,
      dayTitle,
      JSON.stringify(muscleGroups),
      ts,
      isAdmin ? 1 : 0,
    ],
  )
  return (result as unknown as InsertResult).insertId
}

export async function recordSetTiming(
  sessionId: number,
  exerciseName: string,
  setIndex: number,
  startTime: string,
  endTime: string,
  weight: number,
  reps: number,
  note: string | null = null,
  isWarmup = false,
  muscleGroup: string | null = null,
): Promise<RecordSetResult> {
  const exerciseId = await findOrCreateExercise(exerciseName, muscleGroup)
  const start = new Date(startTime)
  const end = new Date(endTime)
  const setDuration = Math.round((end.getTime() - start.getTime()) / 1000)

  const [lastSets] = await pool.execute<LastSetRow[]>(
    `SELECT end_time FROM set_timings WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  )
  const restTime: number | null =
    lastSets.length > 0
      ? Math.round(
          (start.getTime() - new Date(lastSets[0].end_time).getTime()) / 1000,
        )
      : null

  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `INSERT INTO set_timings (session_id, exercise_id, set_index, start_time, end_time, set_duration, rest_time, weight, reps, note, is_warmup)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      exerciseId,
      setIndex,
      formatDateForMySQL(startTime),
      formatDateForMySQL(endTime),
      setDuration,
      restTime,
      weight,
      reps,
      note,
      isWarmup ? 1 : 0,
    ],
  )
  await pool.execute(
    `UPDATE sessions SET completed_sets = completed_sets + 1 WHERE id = ?`,
    [sessionId],
  )
  return {
    id: (result as unknown as InsertResult).insertId,
    exerciseId,
    setDuration,
    restTime,
  }
}

export interface UpdateSetTimingParams {
  exerciseName?: string
  muscleGroup?: string | null
  weight?: number
  reps?: number
  startTime?: string
  endTime?: string
  note?: string | null
  isWarmup?: boolean
}

/**
 * Update a single recorded set. Verifies the set belongs to a session owned by
 * the caller, applies only the provided fields, and recomputes set_duration if
 * either timestamp changes. Returns the updated row joined with its exercise.
 */
export async function updateSetTiming(
  sessionId: number,
  setId: number,
  userId: number,
  updates: UpdateSetTimingParams,
): Promise<SetTiming> {
  const [owned] = await pool.execute<SetTimingRow[]>(
    `SELECT st.* FROM set_timings st
     JOIN sessions s ON st.session_id = s.id
     WHERE st.id = ? AND st.session_id = ? AND s.user_id = ?`,
    [setId, sessionId, userId],
  )
  if (!owned[0]) throw new NotFoundError("Set")

  const assignments: string[] = []
  const params: (string | number | null)[] = []

  if (updates.exerciseName !== undefined) {
    const exerciseId = await findOrCreateExercise(
      updates.exerciseName,
      updates.muscleGroup ?? null,
    )
    assignments.push("exercise_id = ?")
    params.push(exerciseId)
  }
  if (updates.weight !== undefined) {
    assignments.push("weight = ?")
    params.push(updates.weight)
  }
  if (updates.reps !== undefined) {
    assignments.push("reps = ?")
    params.push(updates.reps)
  }
  if (updates.note !== undefined) {
    assignments.push("note = ?")
    params.push(updates.note)
  }
  if (updates.isWarmup !== undefined) {
    assignments.push("is_warmup = ?")
    params.push(updates.isWarmup ? 1 : 0)
  }
  if (updates.startTime !== undefined) {
    assignments.push("start_time = ?")
    params.push(formatDateForMySQL(updates.startTime))
  }
  if (updates.endTime !== undefined) {
    assignments.push("end_time = ?")
    params.push(formatDateForMySQL(updates.endTime))
  }
  if (updates.startTime !== undefined || updates.endTime !== undefined) {
    const start = new Date(updates.startTime ?? (owned[0].start_time as string))
    const end = new Date(updates.endTime ?? (owned[0].end_time as string))
    assignments.push("set_duration = ?")
    params.push(Math.round((end.getTime() - start.getTime()) / 1000))
  }

  if (assignments.length > 0) {
    params.push(setId)
    await pool.execute(
      `UPDATE set_timings SET ${assignments.join(", ")} WHERE id = ?`,
      params,
    )
  }

  const [updated] = await pool.execute<SetTimingRow[]>(
    `SELECT st.*, e.name AS exercise_name, e.muscle_group AS exercise_muscle_group
     FROM set_timings st JOIN exercises e ON st.exercise_id = e.id
     WHERE st.id = ?`,
    [setId],
  )
  return stripDates(
    updated[0] as unknown as Record<string, unknown>,
  ) as unknown as SetTiming
}

/**
 * Rename (and/or re-group) an exercise everywhere it appears in a person's
 * session history. Because the exercises table is shared globally (unique by
 * name), we re-point the matching set_timings rows at the target exercise
 * rather than mutating the shared exercise row. Returns the number of set rows
 * updated.
 */
export async function renameExerciseInHistory(
  userId: number,
  person: string,
  oldName: string,
  newName?: string,
  muscleGroup?: string | null,
): Promise<number> {
  const targetName = newName?.trim() || oldName
  const targetExerciseId = await findOrCreateExercise(
    targetName,
    muscleGroup ?? null,
  )
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `UPDATE set_timings st
     JOIN sessions s ON st.session_id = s.id
     JOIN exercises e ON st.exercise_id = e.id
     SET st.exercise_id = ?
     WHERE s.user_id = ? AND s.person = ? AND e.name = ?`,
    [targetExerciseId, userId, person, oldName],
  )
  return (result as unknown as InsertResult).affectedRows
}

export async function endSession(
  sessionId: number,
  endTime: string | Date | null = null,
): Promise<Session> {
  const ts = formatDateForMySQL(endTime ?? new Date())
  await pool.execute(
    `UPDATE sessions SET end_time = ?, total_duration = TIMESTAMPDIFF(SECOND, start_time, ?) WHERE id = ?`,
    [ts, ts, sessionId],
  )
  const [rows] = await pool.execute<SessionRow[]>(
    `SELECT * FROM sessions WHERE id = ?`,
    [sessionId],
  )
  return rows[0] as unknown as Session
}

export async function getSessionDetails(
  sessionId: number,
  userId: number,
): Promise<Session> {
  const [sessions] = await pool.execute<SessionRow[]>(
    `SELECT s.*, u.name AS user_name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ? AND s.user_id = ?`,
    [sessionId, userId],
  )
  if (!sessions[0])
    throw new ForbiddenError("Session not found or unauthorized")

  const [timings] = await pool.execute<SetTimingRow[]>(
    `SELECT st.*, e.name AS exercise_name, e.muscle_group AS exercise_muscle_group
     FROM set_timings st JOIN exercises e ON st.exercise_id = e.id
     WHERE st.session_id = ? ORDER BY e.name ASC, st.set_index ASC, st.start_time ASC`,
    [sessionId],
  )
  return {
    ...stripDates(sessions[0] as unknown as Record<string, unknown>),
    muscle_groups: parseMuscleGroups(sessions[0].muscle_groups),
    set_timings: timings.map((t) =>
      stripDates(t as unknown as Record<string, unknown>),
    ),
  } as unknown as Session
}

export async function getSessionHistory(
  userId: number,
  person?: string | null,
  dayNumber?: number | null,
  limit = 30,
  includeTimings = false,
): Promise<Session[]> {
  let q = `SELECT s.*, u.name AS user_name, u.username,
      (SELECT COUNT(*) FROM set_timings WHERE session_id = s.id) AS set_count
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.user_id = ? AND s.is_admin = 0`
  const params: unknown[] = [userId]
  if (person) {
    q += ` AND s.person = ?`
    params.push(person)
  }
  if (dayNumber != null) {
    q += ` AND s.day_number = ?`
    params.push(dayNumber)
  }
  q += ` ORDER BY s.start_time DESC LIMIT ?`
  params.push(limit)

  const [rows] = await dbQuery<SessionRow[]>(q, params)
  if (!rows.length) return []

  const sessions: Session[] = rows.map((r) => ({
    ...(stripDates(
      r as unknown as Record<string, unknown>,
    ) as unknown as Session),
    muscle_groups: parseMuscleGroups(r.muscle_groups),
    set_timings: [],
  }))

  if (includeTimings) {
    const ids = sessions.map((s) => s.id)
    // ids come entirely from our own DB query above — safe to interpolate
    // placeholders. Never use this pattern with user-supplied values.
    const [timings] = await pool.execute<SetTimingRow[]>(
      `SELECT st.*, e.name AS exercise_name, e.muscle_group AS exercise_muscle_group
       FROM set_timings st JOIN exercises e ON st.exercise_id = e.id
       WHERE st.session_id IN (${ids.map(() => "?").join(",")})
       ORDER BY st.session_id, st.set_index ASC`,
      ids,
    )
    const bySession: Record<number, SetTiming[]> = {}
    for (const t of timings) {
      if (!bySession[t.session_id]) bySession[t.session_id] = []
      bySession[t.session_id].push(
        stripDates(
          t as unknown as Record<string, unknown>,
        ) as unknown as SetTiming,
      )
    }
    sessions.forEach((s) => {
      s.set_timings = bySession[s.id] || []
    })
  }
  return sessions
}

export async function clearAdminSessions(userId: number): Promise<number> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`DELETE FROM sessions WHERE is_admin = 1 AND user_id = ?`, [userId])
  return (result as unknown as InsertResult).affectedRows
}

export async function deleteAllSessionsForPerson(
  userId: number,
  person: string,
): Promise<{ success: boolean; deletedCount: number; message: string }> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [sessions] = await conn.execute<(RowDataPacket & { id: number })[]>(
      `SELECT id FROM sessions WHERE user_id = ? AND person = ?`,
      [userId, person],
    )
    const ids = sessions.map((r) => r.id)
    if (!ids.length) {
      await conn.rollback()
      return {
        success: false,
        deletedCount: 0,
        message: `No sessions found for person: ${person}`,
      }
    }
    // set_timings rows are covered by ON DELETE CASCADE on fk_st_session,
    // so we only need to delete the parent sessions rows.
    const [del] = await conn.execute<
      InsertResult & { constructor: { name: string } }
    >(`DELETE FROM sessions WHERE user_id = ? AND person = ?`, [userId, person])
    await conn.commit()
    const affectedRows = (del as unknown as InsertResult).affectedRows
    return {
      success: true,
      deletedCount: affectedRows,
      message: `Deleted ${affectedRows} session(s) for person: ${person}`,
    }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function deleteAllSessions(userId: number): Promise<number> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`DELETE FROM sessions WHERE user_id = ? AND is_admin = 0`, [userId])
  return (result as unknown as InsertResult).affectedRows
}

export async function updateSessionPerson(
  sessionId: number,
  userId: number,
  person: string,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`UPDATE sessions SET person = ? WHERE id = ? AND user_id = ?`, [
    person,
    sessionId,
    userId,
  ])
  if ((result as unknown as InsertResult).affectedRows === 0)
    throw new NotFoundError("Session")
  return true
}

interface SessionStatsRow extends RowDataPacket {
  total_sessions: number
  total_sets: number
  avg_rest_time: number
  avg_set_duration: number
  total_volume: number
  first_session: Date | string | null
  last_session: Date | string | null
}

export async function getSessionStats(
  userId: number,
  person?: string | null,
  dayNumber?: number | null,
): Promise<SessionStatsRow> {
  let q = `SELECT COUNT(DISTINCT s.id) AS total_sessions, COUNT(st.id) AS total_sets,
      AVG(st.rest_time) AS avg_rest_time, AVG(st.set_duration) AS avg_set_duration,
      SUM(st.weight * st.reps) AS total_volume,
      MIN(s.start_time) AS first_session, MAX(s.start_time) AS last_session
     FROM sessions s LEFT JOIN set_timings st ON s.id = st.session_id
     WHERE s.user_id = ? AND s.is_admin = 0 AND s.end_time IS NOT NULL`
  const params: unknown[] = [userId]
  if (person) {
    q += ` AND s.person = ?`
    params.push(person)
  }
  if (dayNumber != null) {
    q += ` AND s.day_number = ?`
    params.push(dayNumber)
  }
  const [rows] = await dbQuery<SessionStatsRow[]>(q, params)
  return rows[0]
}

// ─── Stale session cleanup ──────────────────────────────────────────────────
//
// A session is only ever closed by the client calling POST /:sessionId/end.
// If the app is killed, crashes, or the device dies mid-workout, that call
// never happens and the session (and the day it belongs to) stays open in
// the DB forever — no server-side backstop existed for this. These two
// functions back a periodic job (see src/jobs/sessionCleanup.ts) that finds
// sessions nobody is actively touching anymore and ends them itself, using
// the same 30-minute inactivity threshold the client already applies
// locally (see WorkoutContext's checkAndEndStaleSession).

export interface StaleSessionRow extends RowDataPacket {
  id: number
  user_id: number
  last_activity: Date | string
}

/**
 * Find open sessions (end_time IS NULL) whose last activity — the end_time
 * of their most recently recorded set, or their start_time if no set was
 * ever recorded — is older than `thresholdMinutes` ago.
 */
export async function findStaleOpenSessions(
  thresholdMinutes: number,
): Promise<StaleSessionRow[]> {
  const [rows] = await pool.execute<StaleSessionRow[]>(
    `SELECT s.id, s.user_id,
            COALESCE(MAX(st.end_time), s.start_time) AS last_activity
     FROM sessions s
     LEFT JOIN set_timings st ON st.session_id = s.id
     WHERE s.end_time IS NULL
     GROUP BY s.id, s.user_id, s.start_time
     HAVING last_activity < (NOW() - INTERVAL ? MINUTE)`,
    [thresholdMinutes],
  )
  return rows
}

/**
 * Auto-end a stale session at its last known activity time — not "now" —
 * so total_duration reflects when the user actually stopped, not whenever
 * the cleanup job happened to run (which could be hours later).
 */
export async function autoEndStaleSession(
  sessionId: number,
  lastActivity: Date | string,
): Promise<Session> {
  return endSession(sessionId, lastActivity)
}
