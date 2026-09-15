import { pool } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import {
  NotFoundError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "@/middleware/errorHandler.js"
import type {
  Friend,
  FriendRequest,
  UserSearchResult,
} from "../social.types.js"

type BlockedUser = { id: number; username: string; name: string; blockedAt: Date }

// Ceiling on the pending-request lists so a user spammed with requests still
// gets a bounded response.
const PENDING_REQUESTS_LIMIT = 500


export async function sendFriendRequest(
  fromUserId: number,
  toUserId: number,
): Promise<number> {
  // Normalized per-pair lock so A->B and B->A requests sent simultaneously
  // can't both pass the "no existing row" check and create duplicate rows.
  const lockKey = `friendship:${Math.min(fromUserId, toUserId)}:${Math.max(fromUserId, toUserId)}`
  const conn = await pool.getConnection()
  try {
    await conn.query("SELECT GET_LOCK(?, 10)", [lockKey])
    try {
      const [blocks] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1`,
        [fromUserId, toUserId, toUserId, fromUserId],
      )
      // Deliberately the same message in both directions: telling the sender
      // "they blocked you" would leak the block back to the person it protects
      // the other user from.
      if (blocks.length)
        throw new ForbiddenError("Cannot send a friend request to this user")

      const [existing] = await conn.execute<RowDataPacket[]>(
        `SELECT id, status FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
        [fromUserId, toUserId, toUserId, fromUserId],
      )
      if (existing[0]) {
        if (existing[0].status === "pending")
          throw new ConflictError("Friend request already pending")
        if (existing[0].status === "accepted")
          throw new ConflictError("Already friends")
      }
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT INTO friendships (user_id, friend_id, status, created_at) VALUES (?, ?, 'pending', NOW())`,
        [fromUserId, toUserId],
      )
      return result.insertId
    } finally {
      await conn.query("SELECT RELEASE_LOCK(?)", [lockKey])
    }
  } finally {
    conn.release()
  }
}

export async function acceptFriendRequest(
  userId: number,
  friendshipId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE friendships SET status = 'accepted', accepted_at = NOW() WHERE id = ? AND friend_id = ? AND status = 'pending'`,
    [friendshipId, userId],
  )
  if (result.affectedRows === 0)
    throw new NotFoundError("Friend request")
  return true
}

export async function rejectFriendRequest(
  userId: number,
  friendshipId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM friendships WHERE id = ? AND friend_id = ? AND status = 'pending'`,
    [friendshipId, userId],
  )
  if (result.affectedRows === 0)
    throw new NotFoundError("Friend request")
  return true
}

/**
 * Unfriending must tear down the access grants too, not just the friendship
 * row. Sharing routes pair areFriends + hasPermission so they fail closed on
 * their own, but a `trainer` grant is read/write against the trainee's
 * sessions, program and analytics — leaving the row behind meant an unfriended
 * trainer kept full access, and only blockUser actually revoked it. Both
 * deletes go in one transaction so access can't survive a half-applied
 * teardown.
 */
export async function removeFriend(
  userId: number,
  friendId: number,
): Promise<boolean> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.execute<ResultSetHeader>(
      `DELETE FROM friendships WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) AND status = 'accepted'`,
      [userId, friendId, friendId, userId],
    )
    if (result.affectedRows === 0) {
      await conn.rollback()
      throw new NotFoundError("Friendship")
    }
    await conn.execute(
      `DELETE FROM sharing_permissions WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`,
      [userId, friendId, friendId, userId],
    )
    await conn.commit()
    return true
  } catch (err) {
    if (!(err instanceof NotFoundError)) await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function getFriends(userId: number): Promise<Friend[]> {
  const [rows] = await pool.execute<(Friend & RowDataPacket)[]>(
    `SELECT f.id AS friendshipId, f.created_at AS friendsSince,
       CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END AS friendUserId,
       CASE WHEN f.user_id = ? THEN u2.username ELSE u1.username END AS username,
       CASE WHEN f.user_id = ? THEN u2.name ELSE u1.name END AS name
     FROM friendships f
     JOIN users u1 ON f.user_id = u1.id JOIN users u2 ON f.friend_id = u2.id
     WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
     ORDER BY f.accepted_at DESC LIMIT 500`,
    [userId, userId, userId, userId, userId],
  )
  return rows
}

export async function getPendingRequests(
  userId: number,
): Promise<FriendRequest[]> {
  const [rows] = await pool.execute<(FriendRequest & RowDataPacket)[]>(
    `SELECT f.id AS friendshipId, f.user_id AS userId, f.created_at AS createdAt, u.username, u.name
     FROM friendships f JOIN users u ON f.user_id = u.id
     WHERE f.friend_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC LIMIT ?`,
    [userId, PENDING_REQUESTS_LIMIT],
  )
  return rows
}

export async function getSentRequests(
  userId: number,
): Promise<FriendRequest[]> {
  const [rows] = await pool.execute<(FriendRequest & RowDataPacket)[]>(
    `SELECT f.id AS friendshipId, f.friend_id AS friendId, f.created_at AS createdAt, u.username, u.name
     FROM friendships f JOIN users u ON f.friend_id = u.id
     WHERE f.user_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC LIMIT ?`,
    [userId, PENDING_REQUESTS_LIMIT],
  )
  return rows
}

export async function areFriends(
  userId1: number,
  userId2: number,
): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM friendships WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) AND status = 'accepted'`,
    [userId1, userId2, userId2, userId1],
  )
  return rows.length > 0
}

export async function searchUsers(
  searchTerm: string,
  currentUserId: number,
  limit = 10,
): Promise<UserSearchResult[]> {
  // Guard against full-table scans from single-char or excessively long terms
  if (searchTerm.length < 2)
    throw new ValidationError("Search term must be at least 2 characters")
  if (searchTerm.length > 50)
    throw new ValidationError("Search term must not exceed 50 characters")

  // The term is bound as a parameter, so this was never injectable — but it
  // is bound *inside* LIKE wildcards, so an unescaped % or _ is still a
  // pattern. `?q=%%` matched every row and dumped the instance's whole member
  // roster (username + real name) to any signed-in user.
  const pattern = `%${searchTerm.replace(/[\\%_]/g, "\\$&")}%`

  const [rows] = await pool.execute<(UserSearchResult & RowDataPacket)[]>(
    `SELECT u.id, u.username, u.name,
       CASE
         WHEN f.id IS NOT NULL AND f.status = 'accepted' THEN 'friend'
         WHEN f.id IS NOT NULL AND f.status = 'pending' AND f.user_id = ? THEN 'request_sent'
         WHEN f.id IS NOT NULL AND f.status = 'pending' AND f.friend_id = ? THEN 'request_received'
         ELSE 'none'
       END AS friendshipStatus
     FROM users u
     LEFT JOIN friendships f ON ((f.user_id = ? AND f.friend_id = u.id) OR (f.user_id = u.id AND f.friend_id = ?))
     WHERE (u.username LIKE ? OR u.name LIKE ?) AND u.id != ?
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks b
         WHERE (b.blocker_id = ? AND b.blocked_id = u.id)
            OR (b.blocker_id = u.id AND b.blocked_id = ?)
       )
     LIMIT ?`,
    [
      currentUserId,
      currentUserId,
      currentUserId,
      currentUserId,
      pattern,
      pattern,
      currentUserId,
      currentUserId,
      currentUserId,
      limit,
    ],
  )
  return rows
}

/**
 * Blocking is the one action that has to hold on its own: with no central
 * moderator, severing the relationship *is* the remedy. So rather than
 * teaching every read path about blocks, a block tears down everything that
 * could still connect the pair — the friendship, both directions of sharing
 * permissions, and any outstanding joint-session invite. `hasPermission`
 * then answers false for watching, history and joint sessions without
 * knowing blocks exist.
 *
 * ponytail: a joint session already running when the block lands keeps
 * streaming until it ends; kick the live socket here if that ever matters.
 */
export async function blockUser(
  blockerId: number,
  blockedId: number,
): Promise<void> {
  if (blockerId === blockedId) {
    throw new ValidationError("Cannot block yourself")
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.execute(
      `INSERT IGNORE INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, NOW())`,
      [blockerId, blockedId],
    )
    await conn.execute(
      `DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
      [blockerId, blockedId, blockedId, blockerId],
    )
    await conn.execute(
      `DELETE FROM sharing_permissions WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`,
      [blockerId, blockedId, blockedId, blockerId],
    )
    await conn.execute(
      `DELETE FROM joint_session_invites WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`,
      [blockerId, blockedId, blockedId, blockerId],
    )
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function unblockUser(
  blockerId: number,
  blockedId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?`,
    [blockerId, blockedId],
  )
  return result.affectedRows > 0
}

export async function getBlockedUsers(userId: number): Promise<BlockedUser[]> {
  const [rows] = await pool.execute<(BlockedUser & RowDataPacket)[]>(
    `SELECT u.id, u.username, u.name, b.created_at AS blockedAt
     FROM user_blocks b JOIN users u ON b.blocked_id = u.id
     WHERE b.blocker_id = ? ORDER BY b.created_at DESC LIMIT 500`,
    [userId],
  )
  return rows
}

export const REPORT_REASONS = [
  "harassment",
  "spam",
  "impersonation",
  "inappropriate",
  "other",
] as const

export type ReportReason = (typeof REPORT_REASONS)[number]

export async function reportUser(
  reporterId: number,
  reportedId: number,
  reason: ReportReason,
  details?: string,
): Promise<number> {
  if (reporterId === reportedId) {
    throw new ValidationError("Cannot report yourself")
  }
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO user_reports (reporter_id, reported_id, reason, details, created_at) VALUES (?, ?, ?, ?, NOW())`,
    [reporterId, reportedId, reason, details?.slice(0, 1000) || null],
  )
  return result.insertId
}

interface ReportRow extends RowDataPacket {
  id: number
  reason: string
  details: string | null
  created_at: Date
  reporter_username: string
  reported_username: string
}

/** Used by the `ownlift reports` CLI — this instance's operator is the only moderator. */
export async function listReports(limit = 100): Promise<ReportRow[]> {
  const [rows] = await pool.execute<ReportRow[]>(
    `SELECT r.id, r.reason, r.details, r.created_at,
            reporter.username AS reporter_username,
            reported.username AS reported_username
     FROM user_reports r
     JOIN users reporter ON r.reporter_id = reporter.id
     JOIN users reported ON r.reported_id = reported.id
     ORDER BY r.created_at DESC LIMIT ?`,
    [limit],
  )
  return rows
}
