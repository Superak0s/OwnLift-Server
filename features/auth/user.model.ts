import type { PoolConnection } from "mysql2/promise"
import { pool } from "@/config/database.js"
import type { RowDataPacket } from "mysql2"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import type { UserBodyData } from "./user.types.js"
import { asDuplicateUserError } from "./auth.model.js"

const ALLOWED_FIELDS = [
  "name",
  "email",
  "bf_formula_sex",
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

    // ck_users_height rejects anything outside 1-300 too; this only gets the
    // user a readable message instead of a driver-level constraint error.
    if (key === "height_cm") {
      const h = Number(updates[key])
      if (!Number.isFinite(h) || h <= 0 || h > 300)
        throw new ValidationError("Height must be between 1-300 cm")
    }

    // ENUM would catch this as a 500; a readable 400 is the point of the loop.
    if (
      key === "bf_formula_sex" &&
      updates[key] !== null &&
      updates[key] !== "male" &&
      updates[key] !== "female"
    )
      throw new ValidationError("bf_formula_sex must be 'male' or 'female'")

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
    `SELECT height_cm, bf_formula_sex, weight_unit FROM users WHERE id = ?`,
    [userId],
  )
  if (!rows[0]) throw new NotFoundError("User")
  return {
    // decimalNumbers on the pool: height_cm is already a number here.
    heightCm: rows[0].height_cm ?? null,
    bfFormulaSex: rows[0].bf_formula_sex || "male",
    weightUnit: rows[0].weight_unit || "kg",
  }
}

/**
 * Every table that references `users`, and the column(s) it does it through,
 * read from the live schema instead of a hand-kept list.
 *
 * The hand-kept list was wrong: it named tables that no longer exist and had
 * never gained `user_blocks` or `user_reports`, so "wipe all my data" quietly
 * left those behind. A new table gets picked up here the moment it declares its
 * foreign key, which is the only way this stays correct.
 *
 * `refresh_tokens` is excluded deliberately: those are auth state, not user
 * data. Wiping them would log the caller out of the very request doing the
 * wiping, and their hashes have no business in a data export.
 */
const EXCLUDED_TABLES = new Set(["refresh_tokens"])

// user_blocks and user_reports point at users in BOTH directions (I block you
// / you block me). Sweeping every FK column would delete and export the other
// direction too — "Clear All Data" erasing the blocks and reports filed
// AGAINST the caller. Only the column meaning "this user authored the row"
// counts as owned data.
const OUTBOUND_ONLY: Record<string, string> = {
  user_blocks: "blocker_id",
  user_reports: "reporter_id",
}

let ownedTables: Promise<Map<string, string[]>> | null = null

function getUserOwnedTables(): Promise<Map<string, string[]>> {
  ownedTables ??= (async () => {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE()
         AND REFERENCED_TABLE_NAME = 'users'
         AND REFERENCED_COLUMN_NAME = 'id'
       ORDER BY TABLE_NAME, COLUMN_NAME`,
    )
    const map = new Map<string, string[]>()
    for (const r of rows) {
      const table = String(r.tableName)
      if (EXCLUDED_TABLES.has(table)) continue
      const outbound = OUTBOUND_ONLY[table]
      if (outbound) {
        map.set(table, [outbound])
        continue
      }
      map.set(table, [...(map.get(table) ?? []), String(r.columnName)])
    }
    return map
  })()
  return ownedTables
}

/** `user_id = ? OR friend_id = ?` — every way this table can point at a user. */
function ownershipClause(columns: string[]): string {
  return columns.map((c) => `${c} = ?`).join(" OR ")
}

/**
 * Per-table ceiling on the export. Nothing should legitimately reach it —
 * `measurements`, the fastest-growing table here, runs a few thousand rows a
 * year — but this endpoint builds every row of every table into one object,
 * stringifies it, then gzips that, with all three live in heap at once.
 * Uncapped it is the single request most likely to OOM a small box.
 */
const EXPORT_ROW_CAP = 50_000

/**
 * Everything this server holds about a user, as plain JSON — the read-side
 * counterpart to deleteAllUserData, for data-portability requests.
 *
 * Photo bytes are not in it and need no special case: they live in
 * `progress_photo_blobs`, which is keyed by photo, not by user, so only the
 * metadata row is reachable from here.
 */
export async function exportUserData(
  userId: number,
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {}

  const [profile] = await pool.execute<RowDataPacket[]>(
    `SELECT id, username, email, name, bf_formula_sex, height_cm, height_unit,
            weight_unit, is_admin, created_at
     FROM users WHERE id = ?`,
    [userId],
  )
  data.profile = profile[0] ?? null

  for (const [table, columns] of await getUserOwnedTables()) {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${table} WHERE ${ownershipClause(columns)} LIMIT ${EXPORT_ROW_CAP}`,
      columns.map(() => userId),
    )
    data[table] = rows
  }

  return { exportedAt: new Date().toISOString(), ...data }
}

/**
 * Delete every piece of data owned by a user WITHOUT deleting the account
 * itself. Used by the "Clear All Data" action: the user stays logged in and can
 * start fresh, but all of their workout, tracking and social data is gone.
 *
 * Runs in a single transaction so a mid-way failure leaves nothing partially
 * wiped. Child rows reached only through a parent (workout_sets,
 * supplement_intake, progress_photo_blobs) go with their parent via
 * ON DELETE CASCADE, which is why they have no user column and never appear
 * in the list above.
 */
export async function deleteAllUserData(userId: number): Promise<void> {
  const tables = await getUserOwnedTables()
  const connection: PoolConnection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    for (const [table, columns] of tables) {
      await connection.execute(
        `DELETE FROM ${table} WHERE ${ownershipClause(columns)}`,
        columns.map(() => userId),
      )
    }

    await connection.commit()
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
}
