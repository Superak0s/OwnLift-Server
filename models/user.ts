// src/models/user.ts
import type { PoolConnection } from "mysql2/promise"
import { pool } from "../config/database"
import { query as dbQuery } from "../config/database"
import type { RowDataPacket } from "mysql2"
import type { InsertResult } from "../types"
import { NotFoundError, ValidationError } from "../middleware/errorHandler"
import type { UserProfile, UserBodyData } from "../types"

export type { UserProfile, UserBodyData }

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface UserProfileRow extends RowDataPacket {
  id: number
  username: string
  email: string
  name: string
  gender: "male" | "female" | null
  height_cm: string | number | null
  height_unit: "cm" | "ft" | null
  weight_unit: "kg" | "lbs" | null
  is_admin: number
  created_at: Date
}

interface HeightRow extends RowDataPacket {
  height_cm: string | number | null
  height_unit: "cm" | "ft" | null
}

interface WeightUnitRow extends RowDataPacket {
  weight_unit: "kg" | "lbs" | null
}

interface BodyDataRow extends RowDataPacket {
  height_cm: string | number | null
  gender: "male" | "female" | null
  weight_unit: "kg" | "lbs" | null
}

// ─── Field allow-list ─────────────────────────────────────────────────────────

const ALLOWED_FIELDS = [
  "name",
  "email",
  "gender",
  "height_cm",
  "height_unit",
  "weight_unit",
] as const
type ProfileField = (typeof ALLOWED_FIELDS)[number]

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function getUserById(userId: number): Promise<UserProfile | null> {
  const [rows] = await pool.execute<UserProfileRow[]>(
    `SELECT id, username, email, name, gender, height_cm, height_unit, weight_unit, is_admin, created_at FROM users WHERE id = ?`,
    [userId],
  )
  if (!rows[0]) return null
  return {
    id: rows[0].id,
    username: rows[0].username,
    email: rows[0].email,
    name: rows[0].name,
    gender: rows[0].gender,
    height_cm:
      rows[0].height_cm != null ? parseFloat(String(rows[0].height_cm)) : null,
    height_unit: rows[0].height_unit,
    weight_unit: rows[0].weight_unit,
    is_admin: !!rows[0].is_admin,
    created_at: rows[0].created_at,
  }
}

export async function getUserByUsername(
  username: string,
): Promise<UserProfile | null> {
  const [rows] = await pool.execute<UserProfileRow[]>(
    `SELECT id, username, email, name, gender, height_cm, height_unit, weight_unit, is_admin, created_at FROM users WHERE username = ?`,
    [username],
  )
  if (!rows[0]) return null
  return {
    id: rows[0].id,
    username: rows[0].username,
    email: rows[0].email,
    name: rows[0].name,
    gender: rows[0].gender,
    height_cm:
      rows[0].height_cm != null ? parseFloat(String(rows[0].height_cm)) : null,
    height_unit: rows[0].height_unit,
    weight_unit: rows[0].weight_unit,
    is_admin: !!rows[0].is_admin,
    created_at: rows[0].created_at,
  }
}

export async function updateUserProfile(
  userId: number,
  updates: Partial<Record<ProfileField, unknown>>,
): Promise<boolean> {
  const fields: string[] = []
  const values: unknown[] = []

  for (const key of ALLOWED_FIELDS) {
    if (updates[key] === undefined) continue

    // Validate height_cm wherever it arrives — not just in setUserHeight
    if (key === "height_cm") {
      const h = Number(updates[key])
      if (!Number.isFinite(h) || h <= 0 || h > 300)
        throw new ValidationError("Height must be between 1-300 cm")
    }

    fields.push(`${key} = ?`)
    values.push(updates[key])
  }

  if (fields.length === 0)
    throw new ValidationError("No valid fields to update")
  values.push(userId)
  await pool.execute(
    `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
    values as (string | number | null)[],
  )
  return true
}

export async function setUserHeight(
  userId: number,
  heightCm: number,
  preferredUnit: "cm" | "ft" = "cm",
): Promise<boolean> {
  if (heightCm <= 0 || heightCm > 300)
    throw new ValidationError("Height must be between 1-300 cm")
  await pool.execute(
    `UPDATE users SET height_cm = ?, height_unit = ? WHERE id = ?`,
    [heightCm, preferredUnit, userId],
  )
  return true
}

export async function getUserHeight(
  userId: number,
): Promise<{ heightCm: number; unit: "cm" | "ft" } | null> {
  const [rows] = await dbQuery<HeightRow[]>(
    `SELECT height_cm, height_unit FROM users WHERE id = ?`,
    [userId],
  )
  if (!rows[0]?.height_cm) return null
  return {
    heightCm: parseFloat(String(rows[0].height_cm)),
    unit: rows[0].height_unit || "cm",
  }
}

export async function setWeightUnit(
  userId: number,
  unit: "kg" | "lbs",
): Promise<boolean> {
  if (!["kg", "lbs"].includes(unit))
    throw new ValidationError('Weight unit must be "kg" or "lbs"')
  await pool.execute(`UPDATE users SET weight_unit = ? WHERE id = ?`, [
    unit,
    userId,
  ])
  return true
}

export async function getWeightUnit(userId: number): Promise<"kg" | "lbs"> {
  const [rows] = await dbQuery<WeightUnitRow[]>(
    `SELECT weight_unit FROM users WHERE id = ?`,
    [userId],
  )
  return rows[0]?.weight_unit || "kg"
}

export async function setUserGender(
  userId: number,
  gender: "male" | "female",
): Promise<boolean> {
  if (!["male", "female"].includes(gender))
    throw new ValidationError('Gender must be "male" or "female"')
  await pool.execute(`UPDATE users SET gender = ? WHERE id = ?`, [
    gender,
    userId,
  ])
  return true
}

export async function getUserBodyData(userId: number): Promise<UserBodyData> {
  const [rows] = await dbQuery<BodyDataRow[]>(
    `SELECT height_cm, gender, weight_unit FROM users WHERE id = ?`,
    [userId],
  )
  if (!rows[0]) throw new NotFoundError("User")
  return {
    heightCm: rows[0].height_cm ? parseFloat(String(rows[0].height_cm)) : null,
    gender: rows[0].gender || "male",
    weightUnit: rows[0].weight_unit || "kg",
  }
}

/**
 * Delete every piece of data owned by a user WITHOUT deleting the account
 * itself. Used by the "Clear All Data" action: the user stays logged in and
 * can start fresh, but all of their workout, tracking and social data is gone.
 *
 * Runs in a single transaction so a mid-way failure leaves nothing partially
 * wiped. Child rows (set_timings, supplement_log, supplement_locations) are
 * removed automatically via ON DELETE CASCADE when their parent row goes, so
 * they are not listed here.
 */
export async function deleteAllUserData(userId: number): Promise<void> {
  const connection: PoolConnection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    // Tables keyed by a single user_id column.
    const userIdTables = [
      "sessions",
      "workout_programs",
      "body_weight",
      "body_fat_measurements",
      "supplements", // cascades supplement_log + supplement_locations
      "progress_photos",
      "macros_goals",
      "macros_intake",
      "protein_intake",
      "joint_session_participants",
    ]
    for (const table of userIdTables) {
      await connection.execute(`DELETE FROM ${table} WHERE user_id = ?`, [
        userId,
      ])
    }

    // Tables where the user can appear on either side of the relationship.
    await connection.execute(
      `DELETE FROM friendships WHERE user_id = ? OR friend_id = ?`,
      [userId, userId],
    )
    await connection.execute(
      `DELETE FROM sharing_permissions WHERE from_user_id = ? OR to_user_id = ?`,
      [userId, userId],
    )
    await connection.execute(
      `DELETE FROM joint_session_invites WHERE from_user_id = ? OR to_user_id = ?`,
      [userId, userId],
    )

    await connection.commit()
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
}

export async function deleteUser(userId: number): Promise<boolean> {
  // All child tables (sessions, set_timings, body_weight, creatine_log,
  // progress_photos, protein_intake, body_fat_measurements, workout_programs,
  // friendships, sharing_permissions) have ON DELETE CASCADE on their FK to
  // users.id — a single DELETE here cascades to all of them automatically.
  // Do NOT maintain a manual cascade list here: it drifts silently when new
  // child tables are added.
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`DELETE FROM users WHERE id = ?`, [userId])
  return (result as unknown as InsertResult).affectedRows > 0
}
