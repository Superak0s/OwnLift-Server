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

/**
 * One row per pair, stored canonically: user_id = LEAST(a,b),
 * friend_id = GREATEST(a,b), with requested_by carrying the direction. That
 * makes uq_friendship the mutual-exclusion primitive — two simultaneous A→B and
 * B→A requests collide on the unique key instead of both passing a "no existing
 * row" read, which is what the advisory GET_LOCK here used to be for.
 */
export async function sendFriendRequest(
  fromUserId: number,
  toUserId: number,
): Promise<number> {
  const [blocks] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM user_blocks
     WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
     LIMIT 1`,
    [fromUserId, toUserId, toUserId, fromUserId],
  )
  // Deliberately the same message in both directions: telling the sender
  // "they blocked you" would leak the block back to the person it protects
  // the other user from.
  if (blocks.length)
    throw new ForbiddenError("Cannot send a friend request to this user")

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO friendships (user_id, friend_id, requested_by)
       VALUES (LEAST(?, ?), GREATEST(?, ?), ?)`,
      [fromUserId, toUserId, fromUserId, toUserId, fromUserId],
    )
    return result.insertId
  } catch (err) {
    if ((err as { code?: string }).code !== "ER_DUP_ENTRY") throw err
  }

  const [existing] = await pool.execute<RowDataPacket[]>(
    `SELECT status FROM friendships
     WHERE user_id = LEAST(?, ?) AND friend_id = GREATEST(?, ?)`,
    [fromUserId, toUserId, fromUserId, toUserId],
  )
  throw new ConflictError(
    existing[0]?.status === "accepted"
      ? "Already friends"
      : "Friend request already pending",
  )
}

export async function acceptFriendRequest(
  userId: number,
  friendshipId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    // Either column may hold the caller now, so the recipient is defined as
    // "in this pair, and not the one who asked".
    `UPDATE friendships SET status = 'accepted', accepted_at = NOW()
     WHERE id = ? AND ? IN (user_id, friend_id) AND requested_by <> ?
       AND status = 'pending'`,
    [friendshipId, userId, userId],
  )
  if (result.affectedRows === 0) throw new NotFoundError("Friend request")
  return true
}

export async function rejectFriendRequest(
  userId: number,
  friendshipId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM friendships
     WHERE id = ? AND ? IN (user_id, friend_id) AND requested_by <> ?
       AND status = 'pending'`,
    [friendshipId, userId, userId],
  )
  if (result.affectedRows === 0) throw new NotFoundError("Friend request")
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
      `DELETE FROM friendships
       WHERE user_id = LEAST(?, ?) AND friend_id = GREATEST(?, ?)
         AND status = 'accepted'`,
      [userId, friendId, userId, friendId],
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
    // The pair is ordered, so "the other one" is one IF and one join rather
    // than a CASE over two copies of the users table.
    `SELECT f.id AS friendshipId, f.created_at AS friendsSince,
            u.id AS friendUserId, u.username, u.name
     FROM friendships f
     JOIN users u ON u.id = IF(f.user_id = ?, f.friend_id, f.user_id)
     WHERE ? IN (f.user_id, f.friend_id) AND f.status = 'accepted'
     ORDER BY f.accepted_at DESC LIMIT 500`,
    [userId, userId],
  )
  return rows
}

export async function getPendingRequests(
  userId: number,
): Promise<FriendRequest[]> {
  const [rows] = await pool.execute<(FriendRequest & RowDataPacket)[]>(
    // Incoming: someone else asked, and the caller is the other half of the pair.
    `SELECT f.id AS friendshipId, f.requested_by AS userId,
            f.created_at AS createdAt, u.username, u.name
     FROM friendships f JOIN users u ON u.id = f.requested_by
     WHERE ? IN (f.user_id, f.friend_id) AND f.requested_by <> ?
       AND f.status = 'pending'
     ORDER BY f.created_at DESC LIMIT ?`,
    [userId, userId, PENDING_REQUESTS_LIMIT],
  )
  return rows
}

export async function getSentRequests(
  userId: number,
): Promise<FriendRequest[]> {
  const [rows] = await pool.execute<(FriendRequest & RowDataPacket)[]>(
    `SELECT f.id AS friendshipId,
            IF(f.user_id = ?, f.friend_id, f.user_id) AS friendId,
            f.created_at AS createdAt, u.username, u.name
     FROM friendships f
     JOIN users u ON u.id = IF(f.user_id = ?, f.friend_id, f.user_id)
     WHERE f.requested_by = ? AND f.status = 'pending'
     ORDER BY f.created_at DESC LIMIT ?`,
    [userId, userId, userId, PENDING_REQUESTS_LIMIT],
  )
  return rows
}

export async function areFriends(
  userId1: number,
  userId2: number,
): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM friendships
     WHERE user_id = LEAST(?, ?) AND friend_id = GREATEST(?, ?)
       AND status = 'accepted'`,
    [userId1, userId2, userId1, userId2],
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
         WHEN f.status = 'accepted' THEN 'friend'
         WHEN f.status = 'pending' AND f.requested_by = ? THEN 'request_sent'
         WHEN f.status = 'pending' THEN 'request_received'
         ELSE 'none'
       END AS friendshipStatus
     FROM users u
     LEFT JOIN friendships f
       ON f.user_id = LEAST(?, u.id) AND f.friend_id = GREATEST(?, u.id)
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
      `INSERT IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)`,
      [blockerId, blockedId],
    )
    await conn.execute(
      `DELETE FROM friendships
       WHERE user_id = LEAST(?, ?) AND friend_id = GREATEST(?, ?)`,
      [blockerId, blockedId, blockerId, blockedId],
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
    `INSERT INTO user_reports (reporter_id, reported_id, reason, details) VALUES (?, ?, ?, ?)`,
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
