import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import { createHash, randomBytes, randomUUID } from "crypto"
import type { SignOptions } from "jsonwebtoken"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { AuthUser } from "./user.types.js"
import { ConflictError } from "@/middleware/errorHandler.js"
import { pool } from "@/config/database.js"

interface AuthUserRow extends RowDataPacket {
  id: number
  username: string
  email: string
  password_hash?: string
  name: string
  is_admin: number
  created_at: Date
}

function toAuthUser(u: AuthUserRow): AuthUser & { password_hash?: string } {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    password_hash: u.password_hash,
    name: u.name,
    isAdmin: !!u.is_admin,
    createdAt: u.created_at,
  }
}

export async function createUser(
  username: string,
  email: string,
  password: string,
  name?: string,
): Promise<number> {
  const passwordHash = await bcrypt.hash(password, 12)

  const [countRows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM users`,
  )
  const existing = (countRows as any)[0]?.cnt ?? 0
  const isAdmin = existing === 0 ? 1 : 0

  // uq_users_username / uq_users_email do the uniqueness check, so there is no
  // pre-check SELECT to lose the race against two simultaneous signups.
  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO users (username, email, password_hash, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, NOW())`,
      [username, email, passwordHash, name || username, isAdmin],
    )
    return result.insertId
  } catch (err) {
    throw asDuplicateUserError(err)
  }
}

/**
 * Turn a MySQL duplicate-key error on `users` into the ConflictError the route
 * would otherwise have produced from a pre-check SELECT. Anything else is
 * rethrown untouched.
 */
export function asDuplicateUserError(err: unknown): unknown {
  const e = err as { errno?: number; message?: string }
  if (e?.errno !== 1062) return err
  return e.message?.includes("uq_users_email")
    ? new ConflictError("Email already registered")
    : new ConflictError("Username already taken")
}

export async function findUserByCredentials(
  usernameOrEmail: string,
): Promise<(AuthUser & { password_hash?: string }) | null> {
  // A username can equal someone's email (admins are made via the CLI, and
  // old rows predate the @ ban), so both arms of the WHERE can match. Prefer
  // the exact username and take one row — which row MySQL returned first used
  // to decide, and that is not an identity rule.
  const [users] = await pool.execute<AuthUserRow[]>(
    `SELECT id, username, email, password_hash, name, is_admin, created_at
     FROM users WHERE username = ? OR email = ?
     ORDER BY (username = ?) DESC LIMIT 1`,
    [usernameOrEmail, usernameOrEmail, usernameOrEmail],
  )
  return users[0] ? toAuthUser(users[0]) : null
}

export async function findUserByUsername(
  username: string,
): Promise<AuthUser | null> {
  const [users] = await pool.execute<AuthUserRow[]>(
    `SELECT id, username, email, name, is_admin, created_at FROM users WHERE username = ?`,
    [username],
  )
  return users[0] ? toAuthUser(users[0]) : null
}

export async function findUserById(userId: number): Promise<AuthUser | null> {
  const [users] = await pool.execute<AuthUserRow[]>(
    `SELECT id, username, email, name, is_admin, created_at FROM users WHERE id = ?`,
    [userId],
  )
  return users[0] ? toAuthUser(users[0]) : null
}

/**
 * Profile plus token_version in one row — authenticateToken needs both on
 * every request, and they live in the same table.
 */
export async function findUserForAuth(
  userId: number,
): Promise<{ user: AuthUser; tokenVersion: number } | null> {
  const [rows] = await pool.execute<
    (AuthUserRow & { token_version: number })[]
  >(
    `SELECT id, username, email, name, is_admin, created_at, token_version
     FROM users WHERE id = ?`,
    [userId],
  )
  const row = rows[0]
  return row
    ? { user: toAuthUser(row), tokenVersion: row.token_version ?? 0 }
    : null
}

export const verifyPassword = (
  plain: string,
  hashed: string,
): Promise<boolean> => bcrypt.compare(plain, hashed)

/**
 * Stand-in hash for the "no such user" signin path. Returning before bcrypt
 * when the username is unknown made signin ~300ms faster for absent accounts
 * than for present ones, which is a readable account-existence oracle even
 * over a LAN. Comparing against this makes both paths pay the same cost.
 *
 * Hashed from a random value, so nothing can match it by design, and computed
 * once rather than per request.
 *
 * Built lazily on the first signin rather than at module load: bcryptjs is
 * pure JS, and hashSync at cost 12 blocks the event loop for well over a
 * second on a small ARM box — a cost every boot used to pay before the server
 * could accept its first connection, whether or not anyone ever signed in.
 */
let dummyPasswordHash: string | null = null

export function getDummyPasswordHash(): string {
  return (dummyPasswordHash ??= bcrypt.hashSync(randomUUID(), 12))
}

export function generateToken(userId: number, tokenVersion: number): string {
  return jwt.sign({ userId, tokenVersion }, process.env.JWT_SECRET!, {
    expiresIn: (process.env.JWT_EXPIRES_IN || "7d") as SignOptions["expiresIn"],
    algorithm: "HS256",
  })
}

/**
 * Current token version for a user — embedded in every JWT issued to them
 * and checked on every authenticated request. Bumping it (see
 * changePassword) invalidates every outstanding token at once, since none of
 * them carry the new version.
 */
export async function getTokenVersion(userId: number): Promise<number> {
  const [rows] = await pool.execute<(RowDataPacket & { token_version: number })[]>(
    "SELECT token_version FROM users WHERE id = ?",
    [userId],
  )
  return rows[0]?.token_version ?? 0
}

/**
 * Permanently delete an account after re-checking the password. Every
 * user-owned table declares ON DELETE CASCADE on users(id), so dropping the
 * row takes the user's workouts, tracking and social data with it.
 *
 * Returns false when the password doesn't match, so the caller can answer
 * 403 rather than 401 - a 401 would look like an expired session to the app.
 */
export async function deleteUserAccount(
  userId: number,
  password: string,
): Promise<boolean> {
  const [rows] = await pool.execute<AuthUserRow[]>(
    "SELECT password_hash FROM users WHERE id = ?",
    [userId],
  )
  const hash = rows[0]?.password_hash
  if (!hash || !(await verifyPassword(password, hash))) return false

  await pool.execute("DELETE FROM users WHERE id = ?", [userId])
  return true
}

export async function changePassword(
  userId: number,
  newPassword: string,
): Promise<boolean> {
  const hash = await bcrypt.hash(newPassword, 12)
  // Bump token_version too, so tokens issued before the password change
  // (e.g. to whoever leaked it) stop working immediately.
  await pool.execute(
    "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?",
    [hash, userId],
  )
  // Same reasoning for refresh tokens: leaving them alive would let a leaked
  // one outlive the password it was meant to be revoked with.
  await revokeRefreshTokens(userId, { allDevices: true })
  return true
}

// -----------------------------------------------------------------------------
// Refresh tokens
// -----------------------------------------------------------------------------

const REFRESH_TTL_DAYS = 30

/**
 * The stored form of a refresh token. A plain digest is enough here - the
 * token is 256 bits of CSPRNG output, not a guessable password, so there is
 * nothing for bcrypt to slow down.
 */
const hashRefreshToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex")

/**
 * Mint a refresh token. Passing an existing `familyId` continues a rotation
 * chain; omitting it starts a new one (i.e. a fresh sign-in).
 */
export async function issueRefreshToken(
  userId: number,
  familyId: string = randomUUID(),
): Promise<string> {
  const token = randomBytes(32).toString("base64url")
  await pool.execute(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, issued_at, expires_at)
     VALUES (?, ?, ?, NOW(), NOW() + INTERVAL ${REFRESH_TTL_DAYS} DAY)`,
    [userId, hashRefreshToken(token), familyId],
  )
  // Rotation writes a row every 15 minutes per device; expired ones are dead
  // weight. Sweeping here keeps the table bounded without a cron job.
  await pool.execute("DELETE FROM refresh_tokens WHERE expires_at < NOW()")
  return token
}

export type RotateResult =
  | { ok: true; userId: number; token: string }
  | { ok: false; reused: boolean }

/**
 * Spend a refresh token and issue its replacement.
 *
 * The UPDATE is the atomic gate: two simultaneous presentations of the same
 * token cannot both claim it, so a replay is caught even under a race. A
 * token that was already spent means a copy leaked - the legitimate client's
 * or an attacker's, indistinguishable - so the entire family is revoked and
 * everyone has to sign in again.
 */
export async function rotateRefreshToken(presented: string): Promise<RotateResult> {
  const hash = hashRefreshToken(presented)

  const [claim] = await pool.execute<ResultSetHeader>(
    `UPDATE refresh_tokens SET used_at = NOW()
     WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
    [hash],
  )

  const [rows] = await pool.execute<
    (RowDataPacket & { user_id: number; family_id: string; used: number })[]
  >(
    `SELECT user_id, family_id, used_at IS NOT NULL AS used
     FROM refresh_tokens WHERE token_hash = ?`,
    [hash],
  )
  const row = rows[0]
  if (!row) return { ok: false, reused: false }

  if (claim.affectedRows === 0) {
    // Revoked or expired is an ordinary dead token; already-used is a replay.
    if (!row.used) return { ok: false, reused: false }
    await pool.execute(
      "UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = ? AND revoked_at IS NULL",
      [row.family_id],
    )
    return { ok: false, reused: true }
  }

  return {
    ok: true,
    userId: row.user_id,
    token: await issueRefreshToken(row.user_id, row.family_id),
  }
}

/**
 * Revoke one refresh token, or every one the user holds. Scoped by user_id so
 * a caller can only ever kill their own sessions. An unknown token is a no-op:
 * sign-out must not report whether it existed.
 */
export async function revokeRefreshTokens(
  userId: number,
  opts: { token?: string; allDevices?: boolean },
): Promise<void> {
  if (opts.allDevices) {
    await pool.execute(
      "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL",
      [userId],
    )
  } else if (opts.token) {
    await pool.execute(
      "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND token_hash = ? AND revoked_at IS NULL",
      [userId, hashRefreshToken(opts.token)],
    )
  }
}

export async function setUserAdmin(userId: number, isAdmin: boolean): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE users SET is_admin = ? WHERE id = ?`,
    [isAdmin ? 1 : 0, userId],
  )
  return result.affectedRows > 0
}

export async function listAdmins(): Promise<AuthUser[]> {
  const [rows] = await pool.execute<AuthUserRow[]>(
    `SELECT id, username, email, name, is_admin, created_at FROM users WHERE is_admin = 1 ORDER BY id ASC`,
  )
  return rows.map(toAuthUser)
}
