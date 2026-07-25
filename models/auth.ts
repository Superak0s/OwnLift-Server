// src/models/auth.ts
import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import type { SignOptions } from "jsonwebtoken"
import type { RowDataPacket } from "mysql2"
import type { InsertResult, AuthUser } from "../types/index.js"
import { pool } from "../config/database.js"

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface AuthUserRow extends RowDataPacket {
  id: number
  username: string
  email: string
  password_hash?: string
  name: string
  is_admin: number
  created_at: Date
}

interface UserIdRow extends RowDataPacket {
  id: number
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function createUser(
  username: string,
  email: string,
  password: string,
  name?: string,
): Promise<number> {
  const passwordHash = await bcrypt.hash(password, await bcrypt.genSalt(12))

  // If this is the first user in the DB, make them an admin.
  const [countRows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM users`,
  )
  const existing = (countRows as any)[0]?.cnt ?? 0
  const isAdmin = existing === 0 ? 1 : 0

  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `INSERT INTO users (username, email, password_hash, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, NOW())`,
    [username, email, passwordHash, name || username, isAdmin],
  )
  return (result as unknown as InsertResult).insertId
}

export async function findUserByCredentials(
  usernameOrEmail: string,
): Promise<(AuthUser & { password_hash?: string }) | null> {
  // Look up by username first, then fall back to email.
  const [byUsername] = await pool.execute<AuthUserRow[]>(
    `SELECT id, username, email, password_hash, name, is_admin, created_at FROM users WHERE username = ?`,
    [usernameOrEmail],
  )
  if (byUsername[0]) {
    const u = byUsername[0]
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      password_hash: u.password_hash,
      name: u.name,
      is_admin: !!u.is_admin,
      created_at: u.created_at,
    }
  }

  const [byEmail] = await pool.execute<AuthUserRow[]>(
    `SELECT id, username, email, password_hash, name, is_admin, created_at FROM users WHERE email = ?`,
    [usernameOrEmail],
  )
  if (byEmail[0]) {
    const u = byEmail[0]
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      password_hash: u.password_hash,
      name: u.name,
      is_admin: !!u.is_admin,
      created_at: u.created_at,
    }
  }
  return null
}

export async function findUserByUsername(
  username: string,
): Promise<AuthUser | null> {
  const [users] = await pool.execute<AuthUserRow[]>(
    `SELECT id, username, email, name, is_admin, created_at FROM users WHERE username = ?`,
    [username],
  )
  const u = users[0]
  if (!u) return null
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    name: u.name,
    is_admin: !!u.is_admin,
    created_at: u.created_at,
  }
}

export async function findUserById(userId: number): Promise<AuthUser | null> {
  const [users] = await pool.execute<AuthUserRow[]>(
    `SELECT id, username, email, name, is_admin, created_at FROM users WHERE id = ?`,
    [userId],
  )
  const u = users[0]
  if (!u) return null
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    name: u.name,
    is_admin: !!u.is_admin,
    created_at: u.created_at,
  }
}

export const verifyPassword = (
  plain: string,
  hashed: string,
): Promise<boolean> => bcrypt.compare(plain, hashed)

export function generateToken(userId: number): string {
  return jwt.sign({ userId }, process.env.JWT_SECRET!, {
    expiresIn: (process.env.JWT_EXPIRES_IN || "7d") as SignOptions["expiresIn"],
    algorithm: "HS256",
  })
}

export async function usernameExists(username: string): Promise<boolean> {
  const [rows] = await pool.execute<UserIdRow[]>(
    "SELECT id FROM users WHERE username = ?",
    [username],
  )
  return rows.length > 0
}

export async function emailExists(email: string): Promise<boolean> {
  const [rows] = await pool.execute<UserIdRow[]>(
    "SELECT id FROM users WHERE email = ?",
    [email],
  )
  return rows.length > 0
}

const ALLOWED_PROFILE_FIELDS = ["name", "email"] as const
type ProfileField = (typeof ALLOWED_PROFILE_FIELDS)[number]

export async function updateUserProfile(
  userId: number,
  updates: Partial<Record<ProfileField, string>>,
): Promise<boolean> {
  const fields: string[] = []
  const values: unknown[] = []
  for (const key of ALLOWED_PROFILE_FIELDS) {
    if (updates[key] !== undefined) {
      fields.push(`${key} = ?`)
      values.push(updates[key])
    }
  }
  if (fields.length === 0) return false
  values.push(userId)
  await pool.execute(
    `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
    values as (string | number | null)[],
  )
  return true
}

export async function changePassword(
  userId: number,
  newPassword: string,
): Promise<boolean> {
  const hash = await bcrypt.hash(newPassword, await bcrypt.genSalt(12))
  await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?", [
    hash,
    userId,
  ])
  return true
}

// ─── Admin helpers
export async function setUserAdmin(userId: number, isAdmin: boolean): Promise<boolean> {
  const [result] = await pool.execute<InsertResult & { constructor: { name: string } }>(
    `UPDATE users SET is_admin = ? WHERE id = ?`,
    [isAdmin ? 1 : 0, userId],
  )
  return (result as unknown as InsertResult).affectedRows > 0
}

export async function listAdmins(): Promise<AuthUser[]> {
  const [rows] = await pool.execute<AuthUserRow[]>(
    `SELECT id, username, email, name, is_admin, created_at FROM users WHERE is_admin = 1 ORDER BY id ASC`,
  )
  return (rows as AuthUserRow[]).map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    name: u.name,
    is_admin: !!u.is_admin,
    created_at: u.created_at,
  }))
}
