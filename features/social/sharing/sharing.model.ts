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
  from_user_id?: number
  to_user_id?: number
  permission_type: PermissionType
  payload: string | null
  created_at: Date
  updated_at: Date
  from_username?: string
  to_username?: string
}

interface FriendSessionRow extends RowDataPacket {
  id: number
  day_number: number
  day_title: string
  start_time: Date | string | null
  end_time: Date | string | null
  total_duration: number | null
  completed_sets: number
  // JSON column — mysql2 auto-parses this to string[] for most rows, but
  // some legacy rows hold a plain comma-joined string. See parseMuscleGroups.
  muscle_groups: string | string[]
}

interface InviteRow extends RowDataPacket {
  id: number
  from_user_id: number
  to_user_id: number
  from_session_id: number | null
  status: string
  expires_at: Date
  created_at: Date
  from_username: string
}

interface ParticipantRow extends RowDataPacket {
  user_id: number
  session_id: number | null
  username: string | null
  exercise_index: number | null
  set_index: number | null
  exercise_name: string | null
  ready_for_next: number
  exercise_names: string | null
  last_updated: Date
}

const VALID_PERMISSION_TYPES: PermissionType[] = [
  "history",
  "analytics",
  "program",
  "joint_session",
  "watch_session",
]

const INVITE_TTL_SECONDS = 120

export async function grantPermission(
  fromUserId: number,
  toUserId: number,
  permissionType: PermissionType,
  payload: Record<string, unknown> | null = null,
): Promise<number> {
  if (!VALID_PERMISSION_TYPES.includes(permissionType))
    throw new ValidationError(`Invalid permission type: ${permissionType}`)

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO sharing_permissions (from_user_id, to_user_id, permission_type, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = NOW()`,
    [
      fromUserId,
      toUserId,
      permissionType,
      payload ? JSON.stringify(payload) : null,
    ],
  )
  const insertResult = result
  if (insertResult.insertId > 0) return insertResult.insertId

  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM sharing_permissions WHERE from_user_id = ? AND to_user_id = ? AND permission_type = ?`,
    [fromUserId, toUserId, permissionType],
  )
  return rows[0].id
}

export async function revokePermission(
  userId: number,
  permissionId: number,
): Promise<void> {
  const [result] = await pool.execute<ResultSetHeader>(`DELETE FROM sharing_permissions WHERE id = ? AND from_user_id = ?`, [
    permissionId,
    userId,
  ])
  if (result.affectedRows === 0)
    throw new NotFoundError("Permission")
}

export async function getGrantedPermissions(
  userId: number,
): Promise<Permission[]> {
  const [rows] = await pool.execute<PermissionRow[]>(
    `SELECT sp.id, sp.to_user_id, sp.permission_type, sp.payload, sp.created_at, sp.updated_at, u.username AS to_username
     FROM sharing_permissions sp JOIN users u ON u.id = sp.to_user_id
     WHERE sp.from_user_id = ? ORDER BY sp.permission_type, sp.created_at DESC LIMIT 500`,
    [userId],
  )
  return rows.map((r) => ({
    ...r,
    payload: r.payload
      ? (JSON.parse(r.payload) as Record<string, unknown>)
      : null,
  }))
}

export async function getReceivedPermissions(
  userId: number,
): Promise<Permission[]> {
  const [rows] = await pool.execute<PermissionRow[]>(
    `SELECT sp.id, sp.from_user_id, sp.permission_type, sp.payload, sp.created_at, sp.updated_at, u.username AS from_username
     FROM sharing_permissions sp JOIN users u ON u.id = sp.from_user_id
     WHERE sp.to_user_id = ? ORDER BY sp.permission_type, sp.created_at DESC LIMIT 500`,
    [userId],
  )
  return rows.map((r) => ({
    ...r,
    payload: r.payload
      ? (JSON.parse(r.payload) as Record<string, unknown>)
      : null,
  }))
}

export async function hasPermission(
  fromUserId: number,
  toUserId: number,
  permissionType: PermissionType,
): Promise<boolean> {
  const [rows] = await pool.execute<(RowDataPacket & { 1: number })[]>(
    `SELECT 1 FROM sharing_permissions WHERE from_user_id = ? AND to_user_id = ? AND permission_type = ? LIMIT 1`,
    [fromUserId, toUserId, permissionType],
  )
  return rows.length > 0
}

export async function getFriendSessions(friendId: number, limit = 60) {
  const [rows] = await pool.execute<FriendSessionRow[]>(
    `SELECT s.id, s.day_number, s.day_title, s.start_time, s.end_time, s.total_duration, s.completed_sets, s.muscle_groups
     FROM sessions s WHERE s.user_id = ? AND s.is_admin = 0 ORDER BY s.start_time DESC LIMIT ?`,
    [friendId, limit],
  )
  return rows.map((s) => ({
    ...s,
    muscle_groups: parseMuscleGroups(s.muscle_groups),
  }))
}

export async function getFriendSessionDetails(
  friendId: number,
  sessionId: number,
) {
  const [rows] = await pool.execute<FriendSessionRow[]>(
    `SELECT s.id, s.day_number, s.day_title, s.start_time, s.end_time, s.total_duration, s.completed_sets, s.muscle_groups
     FROM sessions s WHERE s.id = ? AND s.user_id = ? AND s.is_admin = 0`,
    [sessionId, friendId],
  )
  if (!rows[0]) return null
  const session = {
    ...rows[0],
    muscle_groups: parseMuscleGroups(rows[0].muscle_groups),
  }
  const [timings] = await pool.execute<RowDataPacket[]>(
    `SELECT st.id, st.set_index, st.weight, st.reps, st.set_duration, st.rest_time,
            e.name AS exercise_name, e.muscle_group AS exercise_muscle_group
     FROM set_timings st JOIN exercises e ON st.exercise_id = e.id
     WHERE st.session_id = ? ORDER BY e.name ASC, st.set_index ASC`,
    [sessionId],
  )
  return { ...session, set_timings: timings }
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
    `INSERT INTO joint_session_invites (from_user_id, to_user_id, from_session_id, status, expires_at, created_at)
     VALUES (?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? SECOND), NOW())`,
    [fromUserId, toUserId, fromSessionId, INVITE_TTL_SECONDS],
  )
  return result.insertId
}

export async function getInvite(inviteId: number): Promise<InviteRow | null> {
  const [rows] = await pool.execute<InviteRow[]>(
    `SELECT i.id, i.from_user_id, i.to_user_id, i.from_session_id, i.status, i.expires_at, i.created_at, u.username AS from_username
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
    const [jsResult] = await conn.execute<ResultSetHeader>(
      `INSERT INTO joint_sessions (status, created_at) VALUES ('active', NOW())`,
    )
    const jointSessionId = jsResult.insertId

    const [users] = await conn.execute<RowDataPacket[]>(
      `SELECT id, username FROM users WHERE id IN (?, ?)`,
      [invite.from_user_id, acceptingUserId],
    )
    const usernameMap = Object.fromEntries(users.map((u) => [u.id, u.username]))

    await conn.execute(
      `INSERT INTO joint_session_participants (joint_session_id, user_id, session_id, username) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      [
        jointSessionId,
        invite.from_user_id,
        invite.from_session_id,
        usernameMap[invite.from_user_id] ?? null,
        jointSessionId,
        acceptingUserId,
        acceptingSessionId,
        usernameMap[acceptingUserId] ?? null,
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
  if (result.affectedRows === 0)
    throw new NotFoundError("Invite")
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
    `SELECT user_id, session_id, username, exercise_index, set_index, exercise_name, ready_for_next, exercise_names, last_updated
     FROM joint_session_participants WHERE joint_session_id = ?`,
    [jointSessionId],
  )

  return {
    id: sessions[0].id,
    status: sessions[0].status,
    createdAt: sessions[0].created_at,
    participants: participants.map(
      (p): JointSessionParticipant => ({
        userId: p.user_id,
        sessionId: p.session_id,
        username: p.username,
        exerciseIndex: p.exercise_index,
        setIndex: p.set_index,
        exerciseName: p.exercise_name,
        readyForNext: !!p.ready_for_next,
        exerciseNames: p.exercise_names
          ? (JSON.parse(p.exercise_names) as string[])
          : null,
        lastUpdated: p.last_updated,
      }),
    ),
  }
}

export async function updateParticipantProgress(
  jointSessionId: number,
  userId: number,
  progress: ParticipantProgress,
): Promise<void> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE joint_session_participants
     SET exercise_index = ?, set_index = ?, exercise_name = ?, ready_for_next = ?,
         exercise_names = ?, last_updated = NOW()
     WHERE joint_session_id = ? AND user_id = ?`,
    [
      progress.exerciseIndex ?? null,
      progress.setIndex ?? null,
      progress.exerciseName ?? null,
      progress.readyForNext ? 1 : 0,
      progress.exerciseNames ? JSON.stringify(progress.exerciseNames) : null,
      jointSessionId,
      userId,
    ],
  )
  if (result.affectedRows === 0)
    throw new NotFoundError("Participant in this joint session")
}

export async function endJointSession(
  jointSessionId: number,
  userId: number,
): Promise<void> {
  const [rows] = await pool.execute<(RowDataPacket & { 1: number })[]>(
    `SELECT 1 FROM joint_session_participants WHERE joint_session_id = ? AND user_id = ?`,
    [jointSessionId, userId],
  )
  if (!rows[0]) throw new NotFoundError("Joint session participant")
  await pool.execute(
    `UPDATE joint_sessions SET status = 'ended' WHERE id = ?`,
    [jointSessionId],
  )
}

/**
 * Returns whether the user has an active (non-ended) session.
 * Pure read — does not mutate any rows.
 */
export async function getUserActiveSessionStatus(
  userId: number,
): Promise<{ hasActiveSession: boolean; sessionId: number | null }> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM sessions WHERE user_id = ? AND end_time IS NULL AND is_admin = 0 ORDER BY start_time DESC LIMIT 1`,
    [userId],
  )
  return rows[0]
    ? { hasActiveSession: true, sessionId: rows[0].id }
    : { hasActiveSession: false, sessionId: null }
}
