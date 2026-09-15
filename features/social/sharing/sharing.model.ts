import { pool } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from "@/middleware/errorHandler.js"
import { parseMuscleGroups } from "@/features/workouts/workouts.model.js"
import type {
  Permission,
  PermissionType,
  JointSession,
  ParticipantProgress,
  JointSessionParticipant,
} from "../social.types.js"

interface PermissionRow extends RowDataPacket {
  id: number
  fromUserId?: number
  toUserId?: number
  permissionType: PermissionType
  /** JSON column — the driver hands back the parsed object. */
  payload: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
  fromUsername?: string
  toUsername?: string
}

interface FriendWorkoutRow extends RowDataPacket {
  id: number
  dayNumber: number
  dayTitle: string
  startTime: Date | string | null
  endTime: Date | string | null
  totalDuration: number | null
  completedSets: number
  primaryMuscles: unknown
  secondaryMuscles: unknown
}

interface InviteRow extends RowDataPacket {
  id: number
  from_user_id: number
  to_user_id: number
  from_workout_id: number | null
  status: string
  expires_at: Date
  created_at: Date
  from_username: string
}

interface ParticipantRow extends RowDataPacket {
  userId: number
  sessionId: number | null
  username: string
  exerciseIndex: number
  setIndex: number
  exerciseName: string | null
  readyForNext: number
  exerciseNames: string[] | null
  lastUpdated: Date
}

const VALID_PERMISSION_TYPES: PermissionType[] = [
  "history",
  "analytics",
  "program",
  "joint_session",
  "watch_session",
  "trainer",
]

const INVITE_TTL_SECONDS = 120

// The pair is stored canonically (user_id = LEAST, friend_id = GREATEST), so
// checking a live friendship against a grant is one equality per column.
const ACCEPTED_FRIENDSHIP_JOIN = `JOIN friendships f
       ON f.status = 'accepted'
      AND f.user_id = LEAST(sp.from_user_id, sp.to_user_id)
      AND f.friend_id = GREATEST(sp.from_user_id, sp.to_user_id)`

export async function grantPermission(
  fromUserId: number,
  toUserId: number,
  permissionType: PermissionType,
  payload: Record<string, unknown> | null = null,
): Promise<number> {
  if (!VALID_PERMISSION_TYPES.includes(permissionType))
    throw new ValidationError(`Invalid permission type: ${permissionType}`)

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO sharing_permissions (from_user_id, to_user_id, permission_type, payload)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), payload = VALUES(payload)`,
    [
      fromUserId,
      toUserId,
      permissionType,
      payload ? JSON.stringify(payload) : null,
    ],
  )
  // LAST_INSERT_ID(id) on the duplicate branch means insertId is the existing
  // row's id, so re-granting doesn't need a second SELECT.
  return result.insertId
}

export async function revokePermission(
  userId: number,
  permissionId: number,
): Promise<void> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM sharing_permissions WHERE id = ? AND from_user_id = ?`,
    [permissionId, userId],
  )
  if (result.affectedRows === 0) throw new NotFoundError("Permission")
}

/**
 * Permissions this user granted to others ("granted") or that others granted
 * to them ("received") — same query mirrored across the two user columns.
 */
export async function getPermissions(
  userId: number,
  direction: "granted" | "received",
): Promise<Permission[]> {
  const [self, other] =
    direction === "granted"
      ? ["from_user_id", "to_user_id"]
      : ["to_user_id", "from_user_id"]
  const label = direction === "granted" ? "to" : "from"
  const [rows] = await pool.execute<PermissionRow[]>(
    `SELECT sp.id, sp.${other} AS ${label}UserId, sp.permission_type AS permissionType, sp.payload, sp.created_at AS createdAt, sp.updated_at AS updatedAt, u.username AS ${label}Username
     FROM sharing_permissions sp JOIN users u ON u.id = sp.${other}
     WHERE sp.${self} = ? ORDER BY sp.permission_type, sp.created_at DESC LIMIT 500`,
    [userId],
  )
  return rows
}

/**
 * Every user who has granted an active `trainer` permission to someone else —
 * i.e. the users a trainee's data is currently visible/writable through.
 * Used to fan out `trainee_set_recorded` WS events.
 */
interface TrainerGrantRow extends RowDataPacket {
  trainerId: number
  trainerUsername: string
}

export async function getActiveTrainers(
  traineeId: number,
): Promise<TrainerGrantRow[]> {
  const [rows] = await pool.execute<TrainerGrantRow[]>(
    // Requires a live friendship as well as the grant — otherwise a stale grant
    // keeps fanning out the trainee's live set events to someone they already
    // unfriended.
    `SELECT sp.to_user_id AS trainerId, u.username AS trainerUsername
     FROM sharing_permissions sp
     JOIN users u ON u.id = sp.to_user_id
     ${ACCEPTED_FRIENDSHIP_JOIN}
     WHERE sp.from_user_id = ? AND sp.permission_type = 'trainer'`,
    [traineeId],
  )
  return rows
}

export async function hasPermission(
  fromUserId: number,
  toUserId: number,
  permissionType: PermissionType,
): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT 1 FROM sharing_permissions WHERE from_user_id = ? AND to_user_id = ? AND permission_type = ? LIMIT 1`,
    [fromUserId, toUserId, permissionType],
  )
  return rows.length > 0
}

// Muscle groups belong to the program day, not to the workout — same LEFT JOIN
// the owner's own history uses, so a friend sees the same labels they do.
const FRIEND_WORKOUT_COLS = `w.id, w.day_number AS dayNumber, w.day_title AS dayTitle,
       w.start_time AS startTime, w.end_time AS endTime,
       w.total_duration AS totalDuration, w.completed_sets AS completedSets,
       pd.primary_muscles AS primaryMuscles,
       pd.secondary_muscles AS secondaryMuscles
     FROM workouts w LEFT JOIN program_days pd ON pd.id = w.program_day_id`

const withMuscles = (w: FriendWorkoutRow) => ({
  ...w,
  primaryMuscles: parseMuscleGroups(w.primaryMuscles),
  secondaryMuscles: parseMuscleGroups(w.secondaryMuscles),
})

export async function getFriendSessions(friendId: number, limit = 60) {
  const [rows] = await pool.execute<FriendWorkoutRow[]>(
    `SELECT ${FRIEND_WORKOUT_COLS}
     WHERE w.user_id = ? AND w.is_demo = 0 ORDER BY w.start_time DESC LIMIT ?`,
    [friendId, limit],
  )
  return rows.map(withMuscles)
}

export async function getFriendSessionDetails(
  friendId: number,
  sessionId: number,
) {
  const [rows] = await pool.execute<FriendWorkoutRow[]>(
    `SELECT ${FRIEND_WORKOUT_COLS} WHERE w.id = ? AND w.user_id = ? AND w.is_demo = 0`,
    [sessionId, friendId],
  )
  if (!rows[0]) return null

  const [sets] = await pool.execute<RowDataPacket[]>(
    `SELECT ws.id, ws.set_index AS setIndex, ws.weight, ws.reps,
            ws.set_duration AS setDuration, ws.rest_time AS restTime,
            ws.machine_name AS machineName, ws.rpe,
            e.name AS exerciseName,
            e.primary_muscles AS exercisePrimaryMuscles,
            e.secondary_muscles AS exerciseSecondaryMuscles
     FROM workout_sets ws JOIN exercises e ON ws.exercise_id = e.id
     WHERE ws.workout_id = ? ORDER BY e.name ASC, ws.set_index ASC`,
    [sessionId],
  )
  return { ...withMuscles(rows[0]), setTimings: sets }
}

export async function createJointInvite(
  fromUserId: number,
  toUserId: number,
  fromSessionId: number | null = null,
): Promise<number> {
  await pool.execute(
    `UPDATE joint_session_invites SET status = 'declined' WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'`,
    [fromUserId, toUserId],
  )
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO joint_session_invites (from_user_id, to_user_id, from_workout_id, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [fromUserId, toUserId, fromSessionId, INVITE_TTL_SECONDS],
  )
  return result.insertId
}

export async function getInvite(inviteId: number): Promise<InviteRow | null> {
  const [rows] = await pool.execute<InviteRow[]>(
    `SELECT i.id, i.from_user_id, i.to_user_id, i.from_workout_id, i.status, i.expires_at, i.created_at, u.username AS from_username
     FROM joint_session_invites i JOIN users u ON u.id = i.from_user_id WHERE i.id = ?`,
    [inviteId],
  )
  return rows[0] ?? null
}

export async function acceptInvite(
  inviteId: number,
  acceptingUserId: number,
  acceptingSessionId: number | null = null,
): Promise<{ jointSessionId: number }> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.execute<InviteRow[]>(
      `SELECT * FROM joint_session_invites WHERE id = ? AND to_user_id = ? AND status = 'pending' AND expires_at > NOW() FOR UPDATE`,
      [inviteId, acceptingUserId],
    )
    if (!rows[0])
      throw new ConflictError("Invite not found, already used, or expired")
    const invite = rows[0]

    await conn.execute(
      `UPDATE joint_session_invites SET status = 'accepted' WHERE id = ?`,
      [inviteId],
    )
    // created_by is what gives this table a foreign key: the session row
    // cascades away with the inviter instead of being swept up later.
    const [jsResult] = await conn.execute<ResultSetHeader>(
      `INSERT INTO joint_sessions (created_by) VALUES (?)`,
      [invite.from_user_id],
    )
    const jointSessionId = jsResult.insertId

    // No username column: it is the same string as users.username and is
    // joined in on read.
    await conn.execute(
      `INSERT INTO joint_session_participants (joint_session_id, user_id, workout_id)
       VALUES (?, ?, ?), (?, ?, ?)`,
      [
        jointSessionId,
        invite.from_user_id,
        invite.from_workout_id,
        jointSessionId,
        acceptingUserId,
        acceptingSessionId,
      ],
    )
    await conn.commit()
    return { jointSessionId }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function declineInvite(
  inviteId: number,
  decliningUserId: number,
): Promise<void> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE joint_session_invites SET status = 'declined' WHERE id = ? AND to_user_id = ? AND status = 'pending'`,
    [inviteId, decliningUserId],
  )
  if (result.affectedRows === 0) throw new NotFoundError("Invite")
}

export async function getJointSession(
  jointSessionId: number,
): Promise<JointSession | null> {
  const [sessions] = await pool.execute<RowDataPacket[]>(
    `SELECT id, status, created_at FROM joint_sessions WHERE id = ?`,
    [jointSessionId],
  )
  if (!sessions[0]) return null

  const [participants] = await pool.execute<ParticipantRow[]>(
    // exerciseName is element exercise_index of the list, not a column of its
    // own — one piece of state, read two ways.
    `SELECT p.user_id AS userId, p.workout_id AS sessionId, u.username,
            p.exercise_index AS exerciseIndex, p.set_index AS setIndex,
            JSON_UNQUOTE(JSON_EXTRACT(p.exercise_names,
              CONCAT('$[', p.exercise_index, ']'))) AS exerciseName,
            p.ready_for_next AS readyForNext, p.exercise_names AS exerciseNames,
            p.last_updated AS lastUpdated
     FROM joint_session_participants p JOIN users u ON u.id = p.user_id
     WHERE p.joint_session_id = ?`,
    [jointSessionId],
  )

  return {
    id: sessions[0].id,
    status: sessions[0].status,
    createdAt: sessions[0].created_at,
    participants: participants.map(
      (p): JointSessionParticipant => ({ ...p, readyForNext: !!p.readyForNext }),
    ),
  }
}

export async function updateParticipantProgress(
  jointSessionId: number,
  userId: number,
  progress: ParticipantProgress,
): Promise<void> {
  // ck_jsp_index: both indices are >= 0 integers, and the columns are NOT NULL.
  // Raw JSON from a socket (or a REST body) — non-numeric values become 0
  // instead of a 1264/1366 error.
  const cleanIndex = (v: unknown): number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0
  const exerciseIndex = cleanIndex(progress.exerciseIndex)
  const assignments = [
    "exercise_index = ?",
    "set_index = ?",
    "ready_for_next = ?",
  ]
  const params: (string | number)[] = [
    exerciseIndex,
    cleanIndex(progress.setIndex),
    progress.readyForNext ? 1 : 0,
  ]

  // A client that knows the whole day's list sends exerciseNames; one that only
  // knows what it is doing right now sends exerciseName, which lands in its own
  // slot (JSON_SET appends when the index is past the end).
  if (progress.exerciseNames) {
    assignments.push("exercise_names = CAST(? AS JSON)")
    params.push(JSON.stringify(progress.exerciseNames))
  } else if (progress.exerciseName) {
    assignments.push(
      "exercise_names = JSON_SET(exercise_names, CONCAT('$[', ?, ']'), ?)",
    )
    params.push(exerciseIndex, progress.exerciseName)
  }

  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE joint_session_participants SET ${assignments.join(", ")}
     WHERE joint_session_id = ? AND user_id = ?`,
    [...params, jointSessionId, userId],
  )
  if (result.affectedRows === 0)
    throw new NotFoundError("Participant in this joint session")
}

export async function endJointSession(
  jointSessionId: number,
  userId: number,
): Promise<void> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT 1 FROM joint_session_participants WHERE joint_session_id = ? AND user_id = ?`,
    [jointSessionId, userId],
  )
  if (!rows[0]) throw new NotFoundError("Joint session participant")
  await pool.execute(`UPDATE joint_sessions SET status = 'ended' WHERE id = ?`, [
    jointSessionId,
  ])
}

/**
 * Returns whether the user has an active (non-ended) workout.
 * Pure read — does not mutate any rows.
 */
export async function getUserActiveSessionStatus(
  userId: number,
): Promise<{ hasActiveSession: boolean; sessionId: number | null }> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    // end_time is not in idx_w_user_start, so with no active workout — the
    // normal state — this walked every workout the user had ever logged before
    // giving up. sessionCleanup ends anything idle >30min, so a workout older
    // than a day is always closed and this bound changes no behaviour.
    `SELECT id FROM workouts
     WHERE user_id = ? AND end_time IS NULL
       AND start_time > NOW() - INTERVAL 1 DAY
     ORDER BY start_time DESC LIMIT 1`,
    [userId],
  )
  return rows[0]
    ? { hasActiveSession: true, sessionId: rows[0].id }
    : { hasActiveSession: false, sessionId: null }
}
