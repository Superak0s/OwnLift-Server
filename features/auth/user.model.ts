import type { PoolConnection } from "mysql2/promise"
import { pool } from "@/config/database.js"
import type { RowDataPacket } from "mysql2"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import type { UserBodyData } from "./user.types.js"
import { asDuplicateUserError } from "./auth.model.js"

const ALLOWED_FIELDS = [
  "name",
  "email",
  "gender",
  "height_cm",
  "height_unit",
  "weight_unit",
] as const
type ProfileField = (typeof ALLOWED_FIELDS)[number]

export async function updateUserProfile(
  userId: number,
  updates: Partial<Record<ProfileField, unknown>>,
): Promise<boolean> {
  const fields: string[] = []
  const values: unknown[] = []

  for (const key of ALLOWED_FIELDS) {
    if (updates[key] === undefined) continue

    // Validate height_cm wherever it arrives
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
  // uq_users_email rejects a taken address, so no pre-check SELECT is needed.
  try {
    await pool.execute(
      `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
      values as (string | number | null)[],
    )
  } catch (err) {
    throw asDuplicateUserError(err)
  }
  return true
}

export async function getUserBodyData(userId: number): Promise<UserBodyData> {
  const [rows] = await pool.execute<RowDataPacket[]>(
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
 * wiped. Child rows (set_timings, supplement_log) are
 * removed automatically via ON DELETE CASCADE when their parent row goes, so
 * they are not listed here.
 */
// Every table keyed by a single user_id column. Shared by deleteAllUserData
// and exportUserData so a table can never be exported but not erased, or
// erased but missing from the export.
const USER_OWNED_TABLES = [
  "sessions",
  "workout_programs",
  "body_weight",
  "body_fat_measurements",
  "body_measurements",
  "hydration_log",
  "muscle_soreness",
  "active_soreness",
  "injuries",
  "personal_muscle_notes",
  "menstrual_cycle",
  "supplements", // cascades supplement_log
  "progress_photos",
  "progress_photos_muscle",
  "macros_goals",
  "macros_intake",
  "joint_session_participants",
] as const

// Photo rows carry a LONGBLOB each; exporting the bytes would turn a JSON
// export into hundreds of megabytes. The metadata goes out, the images don't.
const EXPORT_COLUMNS: Record<string, string> = {
  progress_photos: "id, mime_type, file_size, taken_at, note, created_at",
  progress_photos_muscle:
    "id, mime_type, file_size, taken_at, notes, angle, custom_side_name, created_at",
}

/**
 * Everything this server holds about a user, as plain JSON — the read-side
 * counterpart to deleteAllUserData, for data-portability requests.
 */
export async function exportUserData(
  userId: number,
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {}

  const [profile] = await pool.execute<RowDataPacket[]>(
    `SELECT id, username, email, name, gender, height_cm, height_unit, weight_unit, is_admin, created_at FROM users WHERE id = ?`,
    [userId],
  )
  data.profile = profile[0] ?? null

  for (const table of USER_OWNED_TABLES) {
    const columns = EXPORT_COLUMNS[table] ?? "*"
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT ${columns} FROM ${table} WHERE user_id = ?`,
      [userId],
    )
    data[table] = rows
  }

  const [friendships] = await pool.execute<RowDataPacket[]>(
    `SELECT id, user_id, friend_id, status, created_at, accepted_at FROM friendships WHERE user_id = ? OR friend_id = ?`,
    [userId, userId],
  )
  data.friendships = friendships

  const [sharing] = await pool.execute<RowDataPacket[]>(
    `SELECT id, from_user_id, to_user_id, permission_type, created_at FROM sharing_permissions WHERE from_user_id = ? OR to_user_id = ?`,
    [userId, userId],
  )
  data.sharing_permissions = sharing

  return {
    exportedAt: new Date().toISOString(),
    ...data,
  }
}

export async function deleteAllUserData(userId: number): Promise<void> {
  const connection: PoolConnection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    for (const table of USER_OWNED_TABLES) {
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

