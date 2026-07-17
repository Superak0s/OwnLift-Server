// src/models/social/friends.ts
import { pool } from "../../config/database"
import crypto from "crypto"
import type { RowDataPacket } from "mysql2"
import type { InsertResult } from "../../types"
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from "../../middleware/errorHandler"
import type {
  Friend,
  FriendRequest,
  UserSearchResult,
  FriendshipStatus,
} from "../../types"

export type { Friend, FriendRequest, UserSearchResult }

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface FriendshipRow extends RowDataPacket {
  id: number
  status: "pending" | "accepted"
  user_id: number
  friend_id: number
}

interface FriendRow extends RowDataPacket {
  friendship_id: number
  friends_since: Date
  friend_user_id: number
  username: string
  name: string
  email: string
}

interface FriendRequestRow extends RowDataPacket {
  friendship_id: number
  user_id?: number
  friend_id?: number
  created_at: Date
  username: string
  name: string
  email: string
}

interface UserSearchRow extends RowDataPacket {
  id: number
  username: string
  name: string
  friendship_status: FriendshipStatus
}

interface IdRow extends RowDataPacket {
  id: number
}


// ─── Queries ──────────────────────────────────────────────────────────────────

export async function sendFriendRequest(
  fromUserId: number,
  toUserId: number,
): Promise<number> {
  const [existing] = await pool.execute<FriendshipRow[]>(
    `SELECT id, status FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
    [fromUserId, toUserId, toUserId, fromUserId],
  )
  if (existing[0]) {
    if (existing[0].status === "pending")
      throw new ConflictError("Friend request already pending")
    if (existing[0].status === "accepted")
      throw new ConflictError("Already friends")
  }
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `INSERT INTO friendships (user_id, friend_id, status, created_at) VALUES (?, ?, 'pending', NOW())`,
    [fromUserId, toUserId],
  )
  return (result as unknown as InsertResult).insertId
}

export async function acceptFriendRequest(
  userId: number,
  friendshipId: number,
): Promise<boolean> {
  const [rows] = await pool.execute<IdRow[]>(
    `SELECT id FROM friendships WHERE id = ? AND friend_id = ? AND status = 'pending'`,
    [friendshipId, userId],
  )
  if (!rows[0]) throw new NotFoundError("Friend request")
  await pool.execute(
    `UPDATE friendships SET status = 'accepted', accepted_at = NOW() WHERE id = ?`,
    [friendshipId],
  )
  return true
}

export async function rejectFriendRequest(
  userId: number,
  friendshipId: number,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `DELETE FROM friendships WHERE id = ? AND friend_id = ? AND status = 'pending'`,
    [friendshipId, userId],
  )
  if ((result as unknown as InsertResult).affectedRows === 0)
    throw new NotFoundError("Friend request")
  return true
}

export async function removeFriend(
  userId: number,
  friendId: number,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `DELETE FROM friendships WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) AND status = 'accepted'`,
    [userId, friendId, friendId, userId],
  )
  if ((result as unknown as InsertResult).affectedRows === 0)
    throw new NotFoundError("Friendship")
  return true
}

export async function getFriends(userId: number): Promise<Friend[]> {
  const [rows] = await pool.execute<FriendRow[]>(
    `SELECT f.id AS friendship_id, f.created_at AS friends_since,
       CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END AS friend_user_id,
       CASE WHEN f.user_id = ? THEN u2.username ELSE u1.username END AS username,
       CASE WHEN f.user_id = ? THEN u2.name ELSE u1.name END AS name,
       CASE WHEN f.user_id = ? THEN u2.email ELSE u1.email END AS email
     FROM friendships f
     JOIN users u1 ON f.user_id = u1.id JOIN users u2 ON f.friend_id = u2.id
     WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
     ORDER BY f.accepted_at DESC`,
    [userId, userId, userId, userId, userId, userId],
  )
  return rows
}

export async function getPendingRequests(
  userId: number,
): Promise<FriendRequest[]> {
  const [rows] = await pool.execute<FriendRequestRow[]>(
    `SELECT f.id AS friendship_id, f.user_id, f.created_at, u.username, u.name, u.email
     FROM friendships f JOIN users u ON f.user_id = u.id
     WHERE f.friend_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`,
    [userId],
  )
  return rows
}

export async function getSentRequests(
  userId: number,
): Promise<FriendRequest[]> {
  const [rows] = await pool.execute<FriendRequestRow[]>(
    `SELECT f.id AS friendship_id, f.friend_id, f.created_at, u.username, u.name, u.email
     FROM friendships f JOIN users u ON f.friend_id = u.id
     WHERE f.user_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`,
    [userId],
  )
  return rows
}

export async function areFriends(
  userId1: number,
  userId2: number,
): Promise<boolean> {
  const [rows] = await pool.execute<IdRow[]>(
    `SELECT id FROM friendships WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) AND status = 'accepted'`,
    [userId1, userId2, userId2, userId1],
  )
  return rows.length > 0
}

// ─── Contact-based friend suggestions ─────────────────────────────────────────

export interface ContactSuggestion {
  id: number
  username: string
  name: string
}

interface EmailRow extends RowDataPacket {
  id: number
  username: string
  name: string
  email: string
}

/**
 * Hash an email the same way the client does (normalized, SHA-256, hex),
 * so we never need to store or transmit anyone's raw email for this feature.
 */
function hashEmail(email: string): string {
  return crypto
    .createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
}

/**
 * Given a set of SHA-256 email hashes from the caller's phone contacts,
 * returns app users whose email hashes to one of those values — excluding
 * the caller themself and anyone they already have a friendship row with
 * (accepted, pending, sent, or received — any status).
 *
 * We only ever compare hashes; no email in the submitted set is ever
 * needed or stored on our side beyond this request.
 */
export async function findFriendSuggestionsByEmailHashes(
  currentUserId: number,
  emailHashes: string[],
): Promise<ContactSuggestion[]> {
  if (!emailHashes.length) return []

  const hashSet = new Set(emailHashes.map((h) => h.toLowerCase()))

  const [rows] = await pool.execute<EmailRow[]>(
    `SELECT u.id, u.username, u.name, u.email
     FROM users u
     WHERE u.id != ?
       AND u.email IS NOT NULL
       AND u.id NOT IN (
         SELECT CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END
         FROM friendships f
         WHERE f.user_id = ? OR f.friend_id = ?
       )`,
    [currentUserId, currentUserId, currentUserId, currentUserId],
  )

  const matches: ContactSuggestion[] = []
  for (const row of rows) {
    if (!row.email) continue
    if (hashSet.has(hashEmail(row.email))) {
      matches.push({ id: row.id, username: row.username, name: row.name })
    }
  }
  return matches
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

  const [rows] = await pool.execute<UserSearchRow[]>(
    `SELECT u.id, u.username, u.name,
       CASE
         WHEN f.id IS NOT NULL AND f.status = 'accepted' THEN 'friend'
         WHEN f.id IS NOT NULL AND f.status = 'pending' AND f.user_id = ? THEN 'request_sent'
         WHEN f.id IS NOT NULL AND f.status = 'pending' AND f.friend_id = ? THEN 'request_received'
         ELSE 'none'
       END AS friendship_status
     FROM users u
     LEFT JOIN friendships f ON ((f.user_id = ? AND f.friend_id = u.id) OR (f.user_id = u.id AND f.friend_id = ?))
     WHERE (u.username LIKE ? OR u.name LIKE ?) AND u.id != ?
     LIMIT ?`,
    [
      currentUserId,
      currentUserId,
      currentUserId,
      currentUserId,
      `%${searchTerm}%`,
      `%${searchTerm}%`,
      currentUserId,
      limit,
    ],
  )
  return rows
}
