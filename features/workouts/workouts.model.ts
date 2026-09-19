import { pool, formatDateForMySQL, parseMySQLDate } from "@/config/database.js"
import type { PoolConnection } from "mysql2/promise"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  throwCheckViolation,
} from "@/middleware/errorHandler.js"

interface SetTiming {
  id: number
  sessionId: number
  exerciseId: number
  exerciseName: string
  exercisePrimaryMuscles: string[]
  exerciseSecondaryMuscles: string[]
  setIndex: number
  startTime: string
  endTime: string
  setDuration: number
  restTime: number | null
  weight: number
  reps: number
  note: string | null
  isWarmup: number
  rpe: number | null
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
  rpe: number | null
  machineName: string | null
}

// The API speaks camelCase, MySQL speaks snake_case. Every workout/set read
// aliases its columns here so rows can go straight to res.json() without a
// mapping layer — alias any new column the same way.
//
// The REST surface still calls a workout a "session" (mount: /api/sessions,
// field: sessionId) even though the tables are `workouts` / `workout_sets`.
// The rename was to stop "sessions" reading as login state next to
// refresh_tokens; it was not a wire break.
//
// primaryMuscles/secondaryMuscles are NOT columns on `workouts` — they are read
// through program_day_id, so editing a program day relabels its history instead
// of leaving stale copies behind. Every query using these columns must carry
// WORKOUT_FROM's LEFT JOIN.
const WORKOUT_COLS = `w.id, w.user_id AS userId, w.day_number AS dayNumber,
  w.day_title AS dayTitle, w.start_time AS startTime,
  w.end_time AS endTime, w.total_duration AS totalDuration,
  w.completed_sets AS completedSets, w.split, w.is_demo AS isDemo,
  pd.primary_muscles AS primaryMuscles, pd.secondary_muscles AS secondaryMuscles`

// LEFT, not INNER: program_day_id is ON DELETE SET NULL, so a workout whose
// program was deleted must still appear in history (with no muscle labels).
const WORKOUT_FROM = `FROM workouts w
  LEFT JOIN program_days pd ON w.program_day_id = pd.id`

const SET_COLS = `ws.id, ws.workout_id AS sessionId, ws.exercise_id AS exerciseId,
  ws.set_index AS setIndex,
  ws.start_time AS startTime, ws.end_time AS endTime,
  ws.set_duration AS setDuration, ws.rest_time AS restTime,
  ws.weight, ws.reps, ws.note, ws.is_warmup AS isWarmup, ws.rpe,
  ws.machine_name AS machineName, e.name AS exerciseName,
  e.primary_muscles AS exercisePrimaryMuscles,
  e.secondary_muscles AS exerciseSecondaryMuscles`

interface WorkoutRow extends RowDataPacket {
  id: number
  userId: number
  dayNumber: number
  dayTitle: string
  // JSON columns from program_days; mysql2 hands them back already parsed, and
  // NULL only when the workout has no program_day link.
  primaryMuscles: string[] | null
  secondaryMuscles: string[] | null
  startTime: Date | string
  endTime: Date | string | null
  totalDuration: number | null
  completedSets: number
  split: string | null
  userName: string
  username: string
  setCount?: number
}

interface WorkoutSetRow extends RowDataPacket {
  id: number
  sessionId: number
  exerciseId: number
  exerciseName: string
  exercisePrimaryMuscles: string[]
  exerciseSecondaryMuscles: string[]
  setIndex: number
  startTime: Date | string
  endTime: Date | string
  setDuration: number
  restTime: number | null
  weight: number
  reps: number
  note: string | null
  isWarmup: number
  rpe: number | null
  machineName: string | null
}

/**
 * Normalise a muscle-group JSON column to string[].
 *
 * `exercises` and `program_days` declare these columns NOT NULL DEFAULT
 * (JSON_ARRAY()), and mysql2 parses JSON columns for you, so a row value is
 * always an array. The only NULL that reaches here comes from a LEFT JOIN that
 * found no program day.
 */
export function parseMuscleGroups(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((g): g is string => typeof g === "string")
    : []
}

/**
 * `exercises` is shared by everyone on the instance and keyed by name, so the
 * first client to log a name decides its muscle groups. When that client sent
 * none, the row stays label-less forever even though every later log carries
 * them — so fill in the blanks.
 *
 * Only the blanks: overwriting a non-empty value would relabel the exercise
 * under every other user's history. That is the same reason
 * renameExerciseInHistory re-points rows instead of mutating the shared one.
 */
export async function backfillMuscles(
  row: RowDataPacket,
  primaryMuscles: string[],
  secondaryMuscles: string[],
): Promise<void> {
  const fills: string[] = []
  const params: string[] = []
  if (!parseMuscleGroups(row.primaryMuscles).length && primaryMuscles.length) {
    fills.push("primary_muscles = ?")
    params.push(JSON.stringify(primaryMuscles))
  }
  if (
    !parseMuscleGroups(row.secondaryMuscles).length &&
    secondaryMuscles.length
  ) {
    fills.push("secondary_muscles = ?")
    params.push(JSON.stringify(secondaryMuscles))
  }
  if (fills.length === 0) return

  await pool.execute(`UPDATE exercises SET ${fills.join(", ")} WHERE id = ?`, [
    ...params,
    row.id,
  ])
}

async function findOrCreateExercise(
  name: string,
  primaryMuscles: string[] = [],
  secondaryMuscles: string[] = [],
): Promise<number> {
  // Hot path: this runs on every recorded set and the exercise almost always
  // exists already, so try a plain read first. The INSERT below writes a row
  // even when its ON DUPLICATE KEY branch is a no-op — a redo-log entry and a
  // row lock per set, for nothing.
  const [hit] = await pool.execute<RowDataPacket[]>(
    `SELECT id, primary_muscles AS primaryMuscles,
            secondary_muscles AS secondaryMuscles
     FROM exercises WHERE name = ?`,
    [name],
  )
  if (hit[0]) {
    await backfillMuscles(hit[0], primaryMuscles, secondaryMuscles)
    return hit[0].id
  }

  // First sighting of this name. The LAST_INSERT_ID trick returns the id
  // atomically whether this is a real insert or a duplicate-key no-op, which
  // is what covers two concurrent requests both missing the SELECT above.
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

/**
 * The program day this workout is running, or null when the user has no
 * program (or none covering this day number). This is the only place the link
 * is resolved; muscle labels are then read through it forever.
 */
async function findProgramDayId(
  userId: number,
  dayNumber: number,
): Promise<number | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT pd.id FROM program_days pd
     JOIN programs p ON pd.program_id = p.id
     WHERE p.user_id = ? AND pd.day_number = ?`,
    [userId, dayNumber],
  )
  return rows[0]?.id ?? null
}

export async function createSession(
  userId: number,
  dayNumber: number,
  dayTitle: string,
  startTime: string | Date | null = null,
  isDemo = false,
  split: string | null = null,
): Promise<number> {
  const ts = formatDateForMySQL(startTime ? startTime : new Date())
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO workouts (user_id, program_day_id, day_number, day_title, split, start_time, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      await findProgramDayId(userId, dayNumber),
      dayNumber,
      dayTitle,
      split,
      ts,
      isDemo ? 1 : 0,
    ],
  )
  return result.insertId
}

export async function recordSetTiming(
  sessionId: number,
  userId: number,
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
  rpe: number | null = null,
): Promise<RecordSetResult> {
  const exerciseId = await findOrCreateExercise(
    exerciseName,
    primaryMuscles,
    secondaryMuscles,
  )
  const start = new Date(startTime)
  const end = new Date(endTime)
  const setDuration = Math.round((end.getTime() - start.getTime()) / 1000)

  const connection: PoolConnection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    // The counter bump doubles as the ownership check, so there is no separate
    // SELECT before this and no window between checking and inserting. It runs
    // first for that reason: the workout_sets FK only proves the workout
    // exists, not that the caller owns it. completed_sets always changes, so
    // affectedRows === 0 means no such workout for this user, full stop.
    //
    // end_time IS NULL is part of it: without that guard a set posted after
    // the workout was ended — by a double-tapped end, or by sessionCleanup
    // closing a workout the user was mid-rest on — landed silently inside a
    // finished workout, with timestamps after its own endTime.
    const [owned] = await connection.execute<ResultSetHeader>(
      `UPDATE workouts SET completed_sets = completed_sets + 1
       WHERE id = ? AND user_id = ? AND end_time IS NULL`,
      [sessionId, userId],
    )
    // Thrown, not rolled back here — the catch below owns the rollback.
    if (owned.affectedRows === 0) {
      // Which of the two it was decides whether the client should reconcile
      // (409, the workout is closed) or stop retrying (403, not theirs).
      const [exists] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM workouts WHERE id = ? AND user_id = ?`,
        [sessionId, userId],
      )
      if (exists.length)
        throw new ConflictError(
          "Session has already ended",
          "SESSION_ALREADY_ENDED",
        )
      throw new ForbiddenError("Session not found or unauthorized")
    }

    const [lastSets] = await connection.execute<RowDataPacket[]>(
      // created_at has 1s resolution — id breaks ties so "previous set" is
      // deterministic for sets logged in the same second.
      `SELECT end_time FROM workout_sets WHERE workout_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [sessionId],
    )
    // Floored at 0: two devices whose clocks disagree produced a negative
    // rest, which reads as a set logged before the one it followed.
    const restTime: number | null =
      lastSets.length > 0
        ? Math.max(
            0,
            Math.round(
              (start.getTime() -
                parseMySQLDate(lastSets[0].end_time).getTime()) /
                1000,
            ),
          )
        : null

    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO workout_sets (workout_id, exercise_id, set_index, start_time, end_time, set_duration, rest_time, weight, reps, note, is_warmup, rpe, machine_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        rpe,
        machineName,
      ],
    )

    await connection.commit()

    return {
      id: result.insertId,
      exerciseId,
      setDuration,
      restTime,
      rpe,
      machineName,
    }
  } catch (err) {
    await connection.rollback()
    // ck_ws_times: an end before the start is a bad request, not a 500.
    throw throwCheckViolation(err, "Set end time cannot be before start time")
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
  rpe?: number | null
  machineName?: string | null
}

/**
 * Update a single recorded set. Verifies the set belongs to a workout owned by
 * the caller, applies only the provided fields, and recomputes set_duration if
 * either timestamp changes. Returns the updated row joined with its exercise.
 */
export async function updateSetTiming(
  sessionId: number,
  setId: number,
  userId: number,
  updates: UpdateSetTimingParams,
): Promise<SetTiming> {
  const [owned] = await pool.execute<WorkoutSetRow[]>(
    `SELECT ws.start_time AS startTime, ws.end_time AS endTime FROM workout_sets ws
     JOIN workouts w ON ws.workout_id = w.id
     WHERE ws.id = ? AND ws.workout_id = ? AND w.user_id = ?`,
    [setId, sessionId, userId],
  )
  if (!owned[0]) throw new NotFoundError("Set")

  const assignments: string[] = []
  const params: (string | number | null)[] = []
  const set = (col: string, value: string | number | null) => {
    assignments.push(`${col} = ?`)
    params.push(value)
  }

  const u = updates
  if (u.exerciseName !== undefined)
    set(
      "exercise_id",
      await findOrCreateExercise(
        u.exerciseName,
        u.primaryMuscles ?? [],
        u.secondaryMuscles ?? [],
      ),
    )
  if (u.weight !== undefined) set("weight", u.weight)
  if (u.reps !== undefined) set("reps", u.reps)
  if (u.note !== undefined) set("note", u.note)
  if (u.isWarmup !== undefined) set("is_warmup", u.isWarmup ? 1 : 0)
  if (u.rpe !== undefined) set("rpe", u.rpe)
  if (u.machineName !== undefined) set("machine_name", u.machineName)
  if (u.startTime !== undefined)
    set("start_time", formatDateForMySQL(u.startTime))
  if (u.endTime !== undefined) set("end_time", formatDateForMySQL(u.endTime))
  if (u.startTime !== undefined || u.endTime !== undefined) {
    const start = parseMySQLDate(u.startTime ?? (owned[0].startTime as string))
    const end = parseMySQLDate(u.endTime ?? (owned[0].endTime as string))
    set("set_duration", Math.round((end.getTime() - start.getTime()) / 1000))
  }

  if (assignments.length > 0) {
    params.push(setId)
    try {
      await pool.execute(
        `UPDATE workout_sets SET ${assignments.join(", ")} WHERE id = ?`,
        params,
      )
    } catch (err) {
      // ck_ws_times: an end before the start is a bad request, not a 500.
      throw throwCheckViolation(err, "Set end time cannot be before start time")
    }
  }

  const [updated] = await pool.execute<WorkoutSetRow[]>(
    `SELECT ${SET_COLS}
     FROM workout_sets ws JOIN exercises e ON ws.exercise_id = e.id
     JOIN workouts w ON ws.workout_id = w.id
     WHERE ws.id = ? AND w.user_id = ?`,
    [setId, userId],
  )
  return updated[0] as unknown as SetTiming
}

/**
 * Delete one recorded set, addressed the way the client knows it: by exercise
 * name and set index rather than by row id, because the app undoes a set it
 * has only ever identified by its position in the day.
 *
 * A set the client already removed locally is not an error — deleting nothing
 * returns deletedCount 0 so a retry after a failed sync is idempotent. Only a
 * missing or foreign workout is a 404.
 */
export async function deleteSetByIndex(
  sessionId: number,
  userId: number,
  exerciseName: string,
  setIndex: number,
): Promise<number> {
  const [owned] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM workouts WHERE id = ? AND user_id = ?`,
    [sessionId, userId],
  )
  if (!owned.length) throw new NotFoundError("Session")

  const connection: PoolConnection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    // Same (exercise, index) can legitimately appear twice — a set re-logged
    // after a failed sync. The most recent row is the one the user just saw.
    const [matches] = await connection.execute<RowDataPacket[]>(
      `SELECT ws.id FROM workout_sets ws JOIN exercises e ON ws.exercise_id = e.id
       WHERE ws.workout_id = ? AND e.name = ? AND ws.set_index = ?
       ORDER BY ws.id DESC LIMIT 1`,
      [sessionId, exerciseName, setIndex],
    )
    if (!matches.length) {
      await connection.commit()
      return 0
    }

    await connection.execute(`DELETE FROM workout_sets WHERE id = ?`, [
      matches[0].id,
    ])
    // completed_sets is the stored count getSessionHistory reports instead of
    // counting rows, so it has to come down with the row. GREATEST floors it
    // at 0 rather than trusting a counter that predates this delete path.
    await connection.execute(
      `UPDATE workouts SET completed_sets = GREATEST(completed_sets - 1, 0) WHERE id = ?`,
      [sessionId],
    )

    await connection.commit()
    return 1
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
}

/**
 * Rename (and/or re-group) an exercise everywhere it appears in a split's
 * workout history. Because the exercises table is shared globally (unique by
 * name), we re-point the matching workout_sets rows at the target exercise
 * rather than mutating the shared exercise row — which would rewrite every
 * other user's history too. Returns the number of set rows updated.
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
    `UPDATE workout_sets ws
     JOIN workouts w ON ws.workout_id = w.id
     JOIN exercises e ON ws.exercise_id = e.id
     SET ws.exercise_id = ?
     WHERE w.user_id = ? AND w.split = ? AND e.name = ?`,
    [targetExerciseId, userId, split, oldName],
  )
  return result.affectedRows
}

/**
 * Close a workout. Idempotent: the `end_time IS NULL` guard makes a retried or
 * double-tapped end a no-op that returns the row as it already stands, rather
 * than rewriting end_time — an end call replayed after a week offline used to
 * turn a 45-minute workout into a 7-day one. `alreadyEnded` tells the client
 * which of the two happened, so it can reconcile instead of retrying.
 */
export async function endSession(
  sessionId: number,
  userId: number,
  endTime: string | Date | null = null,
): Promise<{ session: Session; alreadyEnded: boolean }> {
  const ts = formatDateForMySQL(endTime ?? new Date())
  // Scoped by user_id like every other statement in this file, rather than
  // trusting the route to have checked first.
  let updated: ResultSetHeader
  try {
    const [res] = await pool.execute<ResultSetHeader>(
      `UPDATE workouts SET end_time = ?, total_duration = TIMESTAMPDIFF(SECOND, start_time, ?)
       WHERE id = ? AND user_id = ? AND end_time IS NULL`,
      [ts, ts, sessionId, userId],
    )
    updated = res
  } catch (err) {
    // ck_w_times: an end before the workout's start is a bad request, not a
    // 500 — the two set paths already treat it that way.
    throw throwCheckViolation(
      err,
      "Session end time cannot be before its start time",
    )
  }
  const [rows] = await pool.execute<WorkoutRow[]>(
    `SELECT ${WORKOUT_COLS} ${WORKOUT_FROM} WHERE w.id = ? AND w.user_id = ?`,
    [sessionId, userId],
  )
  const row = rows[0]
  // The UPDATE reports 0 rows for an unchanged value as well as for a missing
  // one, so ownership is decided by the read, not by affectedRows.
  if (!row) throw new ForbiddenError("Session not found or unauthorized")
  return {
    session: {
      ...row,
      primaryMuscles: parseMuscleGroups(row.primaryMuscles),
      secondaryMuscles: parseMuscleGroups(row.secondaryMuscles),
    } as unknown as Session,
    alreadyEnded: updated.affectedRows === 0,
  }
}

export async function getSessionDetails(
  sessionId: number,
  userId: number,
): Promise<Session> {
  const [workouts] = await pool.execute<WorkoutRow[]>(
    `SELECT ${WORKOUT_COLS}, u.name AS userName ${WORKOUT_FROM}
     JOIN users u ON w.user_id = u.id WHERE w.id = ? AND w.user_id = ?`,
    [sessionId, userId],
  )
  if (!workouts[0])
    throw new ForbiddenError("Session not found or unauthorized")

  const [sets] = await pool.execute<WorkoutSetRow[]>(
    `SELECT ${SET_COLS}
     FROM workout_sets ws JOIN exercises e ON ws.exercise_id = e.id
     -- Insertion order IS the order the sets were performed, and it is the only
     -- record of it since exercise_index was dropped. Sorting by exercise name
     -- listed a workout alphabetically; sorting by set_index interleaved the
     -- exercises. idx_ws_workout_created covers this exactly.
     WHERE ws.workout_id = ? ORDER BY ws.created_at ASC, ws.id ASC`,
    [sessionId],
  )
  return {
    ...workouts[0],
    primaryMuscles: parseMuscleGroups(workouts[0].primaryMuscles),
    secondaryMuscles: parseMuscleGroups(workouts[0].secondaryMuscles),
    setTimings: sets,
  } as unknown as Session
}

export async function getSessionHistory(
  userId: number,
  split?: string | null,
  dayNumber?: number | null,
  limit = 30,
  includeTimings = false,
): Promise<Session[]> {
  // setCount was a correlated (SELECT COUNT(*) FROM workout_sets ...) — one
  // index scan per returned row, up to 365 of them on a single request.
  // workouts.completed_sets is maintained inside the same transaction as the
  // set itself — incremented by recordSetTiming, decremented by
  // deleteSetByIndex — so the column already holds exactly this number.
  let q = `SELECT ${WORKOUT_COLS}, u.name AS userName, u.username,
      w.completed_sets AS setCount
     ${WORKOUT_FROM} JOIN users u ON w.user_id = u.id
     WHERE w.user_id = ?`
  const params: any[] = [userId]
  if (split) {
    q += ` AND w.split = ?`
    params.push(split)
  }
  if (dayNumber != null) {
    q += ` AND w.day_number = ?`
    params.push(dayNumber)
  }
  q += ` ORDER BY w.start_time DESC LIMIT ?`
  params.push(limit)

  const [rows] = await pool.execute<WorkoutRow[]>(q, params)
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
    const [sets] = await pool.execute<WorkoutSetRow[]>(
      `SELECT ${SET_COLS}
       FROM workout_sets ws JOIN exercises e ON ws.exercise_id = e.id
       WHERE ws.workout_id IN (${ids.map(() => "?").join(",")})
       ORDER BY ws.workout_id ASC, ws.created_at ASC, ws.id ASC`,
      ids,
    )
    const bySession: Record<number, SetTiming[]> = {}
    for (const t of sets) {
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
  // workout_sets rows are covered by ON DELETE CASCADE on fk_ws_workout, so
  // deleting the parent workouts rows is the whole job — one statement, no
  // transaction needed.
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM workouts WHERE user_id = ? AND split = ?`,
    [userId, split],
  )
  return result.affectedRows
}

export async function deleteDemoSessions(userId: number): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM workouts WHERE user_id = ? AND is_demo = 1`,
    [userId],
  )
  return result.affectedRows
}

export async function updateSessionSplit(
  sessionId: number,
  userId: number,
  split: string,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE workouts SET split = ? WHERE id = ? AND user_id = ?`,
    [split, sessionId, userId],
  )
  if (result.affectedRows === 0) throw new NotFoundError("Session")
  return true
}

// A workout is only ever closed by the client calling POST /:sessionId/end.
// If the app is killed, crashes, or the device dies mid-workout, that call
// never happens and the workout (and the day it belongs to) stays open in
// the DB forever — no server-side backstop existed for this. This function
// backs a periodic job (see jobs/sessionCleanup.ts) that ends workouts nobody
// is actively touching anymore, using the same 30-minute inactivity threshold
// the client already applies locally (see WorkoutContext's
// checkAndEndStaleSession).

/**
 * End every open workout (end_time IS NULL) whose last activity — the end_time
 * of its most recently recorded set, or its start_time if no set was ever
 * recorded — is older than `thresholdMinutes` ago.
 *
 * Workouts are ended AT their last activity, not at "now", so total_duration
 * reflects when the user actually stopped rather than whenever the cleanup job
 * happened to run.
 *
 * Returns the (id, userId) pairs it ended, so the caller can tell the owner's
 * device: without an event the app's first sign is a 404 on the next set, which
 * silently drops the set the user just did.
 */
export async function endStaleSessions(
  thresholdMinutes: number,
): Promise<{ id: number; userId: number }[]> {
  // Read the candidates first so the caller has ids to notify; the UPDATE below
  // still carries the same predicate and is what actually decides. A workout
  // the owner closed in the moment between the two is skipped by the UPDATE but
  // still listed here — an extra event for a session the client already ended,
  // which it ignores. Not worth a second round-trip to avoid.
  const [stale] = await pool.execute<RowDataPacket[]>(
    `SELECT w.id, w.user_id AS userId FROM workouts w
     WHERE w.end_time IS NULL
       AND GREATEST(
             w.start_time,
             COALESCE(
               (SELECT MAX(ws.end_time) FROM workout_sets ws WHERE ws.workout_id = w.id),
               w.start_time
             )
           ) < (NOW() - INTERVAL ? MINUTE)`,
    [thresholdMinutes],
  )
  if (stale.length === 0) return []

  await pool.execute<ResultSetHeader>(
    // Correlated, not a derived table: grouping all of workout_sets by
    // workout_id materialised the entire table every run, forever, to find the
    // handful of rows where end_time IS NULL. This way the lookup runs only
    // for open workouts and rides the workout_id index prefix.
    //
    // total_duration reads w.end_time set on the line above it — MySQL
    // evaluates UPDATE assignments left to right and later ones see the new
    // values. That is MySQL-specific, and the reason the subquery isn't
    // repeated a third time here.
    // GREATEST(w.start_time, ...): nothing stops a client sending a set whose
    // end_time predates its workout's start_time (a tablet with a slow clock,
    // or a queued offline set replayed later). One such row made this single
    // statement violate ck_w_times, which meant *no* workout on the instance
    // was ever auto-ended again — the job failed on every 5-minute tick.
    `UPDATE workouts w
     SET w.end_time = GREATEST(
           w.start_time,
           COALESCE(
             (SELECT MAX(ws.end_time) FROM workout_sets ws WHERE ws.workout_id = w.id),
             w.start_time
           )
         ),
         w.total_duration = TIMESTAMPDIFF(SECOND, w.start_time, w.end_time)
     WHERE w.end_time IS NULL
       AND GREATEST(
             w.start_time,
             COALESCE(
               (SELECT MAX(ws.end_time) FROM workout_sets ws WHERE ws.workout_id = w.id),
               w.start_time
             )
           ) < (NOW() - INTERVAL ? MINUTE)`,
    [thresholdMinutes],
  )
  return stale.map((r) => ({ id: r.id as number, userId: r.userId as number }))
}
