import { pool, formatDateForMySQL } from "@/config/database.js"
import type { PoolConnection } from "mysql2/promise"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { NotFoundError, ForbiddenError } from "@/middleware/errorHandler.js"

interface SetTiming {
  id: number
  sessionId: number
  exerciseId: number
  exerciseIndex: number | null
  exerciseName: string
  exercisePrimaryMuscles: string[] | null
  exerciseSecondaryMuscles: string[] | null
  setIndex: number
  startTime: string
  endTime: string
  setDuration: number
  restTime: number | null
  weight: number
  reps: number
  note: string | null
  isWarmup: number
  machineName: string | null
}

export interface Session {
  id: number
  userId: number
  dayNumber: number
  dayTitle: string
  primaryMuscles: string[]
  secondaryMuscles: string[]
  startTime: string
  endTime: string | null
  totalDuration: number | null
  completedSets: number
  split: string | null
  isDemo: boolean
  userName: string
  setTimings: SetTiming[]
}

interface RecordSetResult {
  id: number
  exerciseId: number
  setDuration: number
  restTime: number | null
  machineName: string | null
}

// The API speaks camelCase, MySQL speaks snake_case. Every session/set read
// aliases its columns here so rows can go straight to res.json() without a
// mapping layer — alias any new column the same way.
const SESSION_COLS = `s.id, s.user_id AS userId, s.day_number AS dayNumber,
  s.day_title AS dayTitle, s.primary_muscles AS primaryMuscles,
  s.secondary_muscles AS secondaryMuscles, s.start_time AS startTime,
  s.end_time AS endTime, s.total_duration AS totalDuration,
  s.completed_sets AS completedSets, s.\`split\`, s.is_demo AS isDemo`

const TIMING_COLS = `st.id, st.session_id AS sessionId, st.exercise_id AS exerciseId,
  st.exercise_index AS exerciseIndex, st.set_index AS setIndex,
  st.start_time AS startTime, st.end_time AS endTime,
  st.set_duration AS setDuration, st.rest_time AS restTime,
  st.weight, st.reps, st.note, st.is_warmup AS isWarmup,
  st.machine_name AS machineName, e.name AS exerciseName,
  e.primary_muscles AS exercisePrimaryMuscles,
  e.secondary_muscles AS exerciseSecondaryMuscles`

interface SessionRow extends RowDataPacket {
  id: number
  userId: number
  dayNumber: number
  dayTitle: string
  // JSON column — mysql2 auto-parses this to string[] for most rows, but
  // some legacy rows hold a plain comma-joined string. See parseMuscleGroups.
  primaryMuscles: string | string[]
  secondaryMuscles: string | string[]
  startTime: Date | string
  endTime: Date | string | null
  totalDuration: number | null
  completedSets: number
  split: string | null
  userName: string
  username: string
  setCount?: number
}

interface SetTimingRow extends RowDataPacket {
  id: number
  sessionId: number
  exerciseId: number
  exerciseIndex: number | null
  exerciseName: string
  exercisePrimaryMuscles: string[] | null
  exerciseSecondaryMuscles: string[] | null
  setIndex: number
  startTime: Date | string
  endTime: Date | string
  setDuration: number
  restTime: number | null
  weight: number
  reps: number
  note: string | null
  isWarmup: number
  machineName: string | null
}

/**
 * Parse the `primary_muscles` / `secondary_muscles` JSON columns into a
 * string[].
 *
 * The columns are MySQL JSON, and mysql2 auto-parses JSON-typed columns for
 * you — so most rows arrive here as an actual array already, not a string.
 * Some older rows apparently hold a plain comma-joined string instead (e.g.
 * "Glutes,Hamstrings"), predating whatever migration/version put this column
 * on JSON.stringify'd data.
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

async function findOrCreateExercise(
  name: string,
  primaryMuscles: string[] = [],
  secondaryMuscles: string[] = [],
): Promise<number> {
  // Use LAST_INSERT_ID trick to get the id atomically whether this is an
  // insert or a duplicate-key no-op. Avoids the INSERT IGNORE + SELECT race
  // where two concurrent requests for the same new exercise could both see
  // 0 rows from the follow-up SELECT.
  await pool.execute(
    `INSERT INTO exercises (name, primary_muscles, secondary_muscles) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [name, JSON.stringify(primaryMuscles), JSON.stringify(secondaryMuscles)],
  )
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT LAST_INSERT_ID() AS id`,
  )
  return rows[0].id
}

export async function createSession(
  userId: number,
  dayNumber: number,
  dayTitle: string,
  primaryMuscles: string[],
  secondaryMuscles: string[],
  startTime: string | Date | null = null,
  isDemo = false,
): Promise<number> {
  const ts = formatDateForMySQL(startTime ? startTime : new Date())
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO sessions (user_id, day_number, day_title, primary_muscles, secondary_muscles, start_time, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      dayNumber,
      dayTitle,
      JSON.stringify(primaryMuscles),
      JSON.stringify(secondaryMuscles),
      ts,
      isDemo ? 1 : 0,
    ],
  )
  return result.insertId
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
  primaryMuscles: string[] = [],
  secondaryMuscles: string[] = [],
  machineName: string | null = null,
): Promise<RecordSetResult> {
  const exerciseId = await findOrCreateExercise(
    exerciseName,
    primaryMuscles,
    secondaryMuscles,
  )
  const start = new Date(startTime)
  const end = new Date(endTime)
  const setDuration = Math.round((end.getTime() - start.getTime()) / 1000)

  const [lastSets] = await pool.execute<RowDataPacket[]>(
    `SELECT end_time FROM set_timings WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  )
  const restTime: number | null =
    lastSets.length > 0
      ? Math.round(
          (start.getTime() - new Date(lastSets[0].end_time).getTime()) / 1000,
        )
      : null

  const connection: PoolConnection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO set_timings (session_id, exercise_id, set_index, start_time, end_time, set_duration, rest_time, weight, reps, note, is_warmup, machine_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        machineName,
      ],
    )
    await connection.execute(
      `UPDATE sessions SET completed_sets = completed_sets + 1 WHERE id = ?`,
      [sessionId],
    )

    await connection.commit()

    return {
      id: result.insertId,
      exerciseId,
      setDuration,
      restTime,
      machineName,
    }
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
}

interface UpdateSetTimingParams {
  exerciseName?: string
  primaryMuscles?: string[]
  secondaryMuscles?: string[]
  weight?: number
  reps?: number
  startTime?: string
  endTime?: string
  note?: string | null
  isWarmup?: boolean
  machineName?: string | null
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
    `SELECT st.start_time AS startTime, st.end_time AS endTime FROM set_timings st
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
      updates.primaryMuscles ?? [],
      updates.secondaryMuscles ?? [],
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
  if (updates.machineName !== undefined) {
    assignments.push("machine_name = ?")
    params.push(updates.machineName)
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
    const start = new Date(updates.startTime ?? (owned[0].startTime as string))
    const end = new Date(updates.endTime ?? (owned[0].endTime as string))
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
    `SELECT ${TIMING_COLS}
     FROM set_timings st JOIN exercises e ON st.exercise_id = e.id
     WHERE st.id = ?`,
    [setId],
  )
  return updated[0] as unknown as SetTiming
}

/**
 * Rename (and/or re-group) an exercise everywhere it appears in a split's
 * session history. Because the exercises table is shared globally (unique by
 * name), we re-point the matching set_timings rows at the target exercise
 * rather than mutating the shared exercise row. Returns the number of set rows
 * updated.
 */
export async function renameExerciseInHistory(
  userId: number,
  split: string,
  oldName: string,
  newName?: string,
  primaryMuscles?: string[],
  secondaryMuscles?: string[],
): Promise<number> {
  const targetName = newName?.trim() || oldName
  const targetExerciseId = await findOrCreateExercise(
    targetName,
    primaryMuscles ?? [],
    secondaryMuscles ?? [],
  )
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE set_timings st
     JOIN sessions s ON st.session_id = s.id
     JOIN exercises e ON st.exercise_id = e.id
     SET st.exercise_id = ?
     WHERE s.user_id = ? AND s.\`split\` = ? AND e.name = ?`,
    [targetExerciseId, userId, split, oldName],
  )
  return result.affectedRows
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
    `SELECT ${SESSION_COLS} FROM sessions s WHERE s.id = ?`,
    [sessionId],
  )
  const row = rows[0]
  return {
    ...row,
    primaryMuscles: parseMuscleGroups(row.primaryMuscles),
    secondaryMuscles: parseMuscleGroups(row.secondaryMuscles),
  } as unknown as Session
}

export async function getSessionDetails(
  sessionId: number,
  userId: number,
): Promise<Session> {
  const [sessions] = await pool.execute<SessionRow[]>(
    `SELECT ${SESSION_COLS}, u.name AS userName FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ? AND s.user_id = ?`,
    [sessionId, userId],
  )
  if (!sessions[0])
    throw new ForbiddenError("Session not found or unauthorized")

  const [timings] = await pool.execute<SetTimingRow[]>(
    `SELECT ${TIMING_COLS}
     FROM set_timings st JOIN exercises e ON st.exercise_id = e.id
     WHERE st.session_id = ? ORDER BY e.name ASC, st.set_index ASC, st.start_time ASC`,
    [sessionId],
  )
  return {
    ...sessions[0],
    primaryMuscles: parseMuscleGroups(sessions[0].primaryMuscles),
    secondaryMuscles: parseMuscleGroups(sessions[0].secondaryMuscles),
    setTimings: timings,
  } as unknown as Session
}

export async function getSessionHistory(
  userId: number,
  split?: string | null,
  dayNumber?: number | null,
  limit = 30,
  includeTimings = false,
): Promise<Session[]> {
  let q = `SELECT ${SESSION_COLS}, u.name AS userName, u.username,
      (SELECT COUNT(*) FROM set_timings WHERE session_id = s.id) AS setCount
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.user_id = ?`
  const params: any[] = [userId]
  if (split) {
    q += ` AND s.\`split\` = ?`
    params.push(split)
  }
  if (dayNumber != null) {
    q += ` AND s.day_number = ?`
    params.push(dayNumber)
  }
  q += ` ORDER BY s.start_time DESC LIMIT ?`
  params.push(limit)

  const [rows] = await pool.execute<SessionRow[]>(q, params)
  if (!rows.length) return []

  const sessions: Session[] = rows.map((r) => ({
    ...(r as unknown as Session),
    primaryMuscles: parseMuscleGroups(r.primaryMuscles),
    secondaryMuscles: parseMuscleGroups(r.secondaryMuscles),
    setTimings: [],
  }))

  if (includeTimings) {
    const ids = sessions.map((s) => s.id)
    // ids come entirely from our own DB query above — safe to interpolate
    // placeholders. Never use this pattern with user-supplied values.
    const [timings] = await pool.execute<SetTimingRow[]>(
      `SELECT ${TIMING_COLS}
       FROM set_timings st JOIN exercises e ON st.exercise_id = e.id
       WHERE st.session_id IN (${ids.map(() => "?").join(",")})
       ORDER BY st.session_id, st.set_index ASC`,
      ids,
    )
    const bySession: Record<number, SetTiming[]> = {}
    for (const t of timings) {
      if (!bySession[t.sessionId]) bySession[t.sessionId] = []
      bySession[t.sessionId].push(t as unknown as SetTiming)
    }
    sessions.forEach((s) => {
      s.setTimings = bySession[s.id] || []
    })
  }
  return sessions
}

export async function deleteAllSessionsForSplit(
  userId: number,
  split: string,
): Promise<number> {
  // set_timings rows are covered by ON DELETE CASCADE on fk_st_session, so
  // deleting the parent sessions rows is the whole job — one statement, no
  // transaction needed.
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM sessions WHERE user_id = ? AND \`split\` = ?`,
    [userId, split],
  )
  return result.affectedRows
}

export async function deleteDemoSessions(userId: number): Promise<number> {
  // set_timings rows are covered by ON DELETE CASCADE on fk_st_session, so
  // deleting the parent sessions rows is the whole job.
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM sessions WHERE user_id = ? AND is_demo = 1`,
    [userId],
  )
  return result.affectedRows
}

export async function updateSessionSplit(
  sessionId: number,
  userId: number,
  split: string,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(`UPDATE sessions SET \`split\` = ? WHERE id = ? AND user_id = ?`, [
    split,
    sessionId,
    userId,
  ])
  if (result.affectedRows === 0)
    throw new NotFoundError("Session")
  return true
}

// A session is only ever closed by the client calling POST /:sessionId/end.
// If the app is killed, crashes, or the device dies mid-workout, that call
// never happens and the session (and the day it belongs to) stays open in
// the DB forever — no server-side backstop existed for this. This function
// backs a periodic job (see jobs/sessionCleanup.ts) that ends sessions nobody
// is actively touching anymore, using the same 30-minute inactivity threshold
// the client already applies locally (see WorkoutContext's
// checkAndEndStaleSession).

/**
 * End every open session (end_time IS NULL) whose last activity — the end_time
 * of its most recently recorded set, or its start_time if no set was ever
 * recorded — is older than `thresholdMinutes` ago.
 *
 * Sessions are ended AT their last activity, not at "now", so total_duration
 * reflects when the user actually stopped rather than whenever the cleanup job
 * happened to run. Returns how many were ended.
 */
export async function endStaleSessions(
  thresholdMinutes: number,
): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE sessions s
     LEFT JOIN (
       SELECT session_id, MAX(end_time) AS last_end
       FROM set_timings GROUP BY session_id
     ) st ON st.session_id = s.id
     SET s.end_time = COALESCE(st.last_end, s.start_time),
         s.total_duration = TIMESTAMPDIFF(
           SECOND, s.start_time, COALESCE(st.last_end, s.start_time)
         )
     WHERE s.end_time IS NULL
       AND COALESCE(st.last_end, s.start_time) < (NOW() - INTERVAL ? MINUTE)`,
    [thresholdMinutes],
  )
  return result.affectedRows
}
