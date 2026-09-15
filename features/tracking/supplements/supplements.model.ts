// Supplements and the doses taken from them (`supplement_intake`).

import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"

/** "HH:MM" from the client → a MySQL TIME literal. */
const simpleTimeToMySQL = (t: string): string => {
  const [h = "00", m = "00"] = t.split(":")
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}:00`
}

export interface Supplement extends RowDataPacket {
  id: number
  name: string
  unit: string
  defaultAmount: number
  reminderEnabled: boolean
  reminderTime: string | null
  color: string | null
  icon: string | null
  createdAt: string
  updatedAt: string
}

interface SupplementSummary extends Omit<Supplement, keyof RowDataPacket> {
  takenToday: boolean
  streak: number
}

interface SupplementEntry extends RowDataPacket {
  id: number
  supplementId: number
  amount: number
  takenAt: string
  note: string | null
  createdAt: string
}

// Aliased to camelCase in SQL, and the pool runs with decimalNumbers, so
// DECIMAL columns arrive as numbers — no parseFloat(String(...)) round trip.
// TIME_FORMAT trims the seconds MySQL pads onto a TIME the client sent as HH:MM.
const SUPPLEMENT_COLS = `id, name, unit, default_amount AS defaultAmount,
       reminder_enabled AS reminderEnabled,
       TIME_FORMAT(reminder_time, '%H:%i') AS reminderTime, color, icon,
       created_at AS createdAt, updated_at AS updatedAt`

const INTAKE_COLS = `id, supplement_id AS supplementId, amount,
       taken_at AS takenAt, note, created_at AS createdAt`

/** The one column the driver won't hand back in its wire type. */
function withBooleans(row: Supplement): Supplement {
  row.reminderEnabled = !!row.reminderEnabled
  return row
}

export async function createSupplement(
  userId: number,
  name: string,
  unit = "g",
  defaultAmount = 5,
  reminderEnabled = false,
  reminderTime: string | null = null,
  color: string | null = null,
  icon: string | null = null,
): Promise<Supplement> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO supplements
       (user_id, name, unit, default_amount, reminder_enabled, reminder_time, color, icon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      name,
      unit,
      defaultAmount,
      reminderEnabled ? 1 : 0,
      reminderTime ? simpleTimeToMySQL(reminderTime) : null,
      color,
      icon,
    ],
  )
  // Always called after validation, so the row must exist.
  return (await getSupplementById(userId, result.insertId))!
}

export async function getSupplementById(
  userId: number,
  supplementId: number,
): Promise<Supplement | null> {
  const [rows] = await pool.execute<Supplement[]>(
    `SELECT ${SUPPLEMENT_COLS} FROM supplements WHERE id = ? AND user_id = ?`,
    [supplementId, userId],
  )
  return rows[0] ? withBooleans(rows[0]) : null
}

/**
 * Every supplement enriched with today's taken status and current streak. One
 * query for the list, one for every logged day across all of them (grouped in
 * JS) — flat cost regardless of how many supplements the user has.
 */
export async function listSupplementSummaries(
  userId: number,
): Promise<SupplementSummary[]> {
  const [supplements] = await pool.execute<Supplement[]>(
    `SELECT ${SUPPLEMENT_COLS} FROM supplements WHERE user_id = ? ORDER BY name ASC`,
    [userId],
  )
  if (supplements.length === 0) return []

  const [rows] = await pool.execute<
    (RowDataPacket & { supplementId: number; day: string })[]
  >(
    // A streak breaks at the first missing day, so anything older than the
    // longest streak this can report is dead weight — cap the scan at a year
    // instead of reading every intake row the user has ever written.
    `SELECT supplement_id AS supplementId, DATE(taken_at) AS day
     FROM supplement_intake
     WHERE user_id = ? AND taken_at >= DATE_SUB(CURDATE(), INTERVAL 366 DAY)
     GROUP BY supplement_id, DATE(taken_at)
     ORDER BY supplement_id, day DESC`,
    [userId],
  )

  const daysBySupplement = new Map<number, string[]>()
  for (const row of rows) {
    const list = daysBySupplement.get(row.supplementId)
    if (list) list.push(row.day)
    else daysBySupplement.set(row.supplementId, [row.day])
  }

  const today = utcDay(new Date())
  return supplements.map((s) => {
    const days = daysBySupplement.get(s.id) ?? []
    return {
      ...withBooleans(s),
      takenToday: days[0] === today,
      streak: streakFromDays(days),
    }
  })
}

/**
 * YYYY-MM-DD in UTC, the form MySQL hands back for DATE(...) — the pool runs
 * with `dateStrings: true`, so these columns arrive as strings and must not be
 * parsed into a Date and read with local getters.
 */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Shared by getStreak and listSupplementSummaries — days must be sorted DESC. */
function streakFromDays(days: string[]): number {
  if (!days.length) return 0

  // A streak may run up to today or up to yesterday; today being unlogged
  // doesn't break it yet.
  const cursor = new Date()
  if (days[0] !== utcDay(cursor)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1)
    if (days[0] !== utcDay(cursor)) return 0
  }

  let streak = 0
  for (const day of days) {
    if (day !== utcDay(cursor)) break
    streak++
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return streak
}

export async function updateSupplement(
  userId: number,
  supplementId: number,
  fields: {
    name?: string
    unit?: string
    defaultAmount?: number
    reminderEnabled?: boolean
    reminderTime?: string | null
    color?: string | null
    icon?: string | null
  },
): Promise<Supplement | null> {
  const COLUMNS = {
    name: "name",
    unit: "unit",
    defaultAmount: "default_amount",
    reminderEnabled: "reminder_enabled",
    reminderTime: "reminder_time",
    color: "color",
    icon: "icon",
  } as const

  const setClauses: string[] = []
  const values: (string | number | null)[] = []
  for (const [key, column] of Object.entries(COLUMNS) as [
    keyof typeof COLUMNS,
    string,
  ][]) {
    const value = fields[key]
    if (value === undefined) continue
    setClauses.push(`${column} = ?`)
    if (key === "reminderEnabled") values.push(value ? 1 : 0)
    else if (key === "reminderTime")
      values.push(value ? simpleTimeToMySQL(value as string) : null)
    else values.push(value as string | number | null)
  }

  if (setClauses.length === 0) return getSupplementById(userId, supplementId)

  await pool.execute(
    `UPDATE supplements SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`,
    [...values, supplementId, userId],
  )
  return getSupplementById(userId, supplementId)
}

export async function deleteSupplement(
  userId: number,
  supplementId: number,
): Promise<boolean> {
  // The intake history goes with it: fk_si_supplement is ON DELETE CASCADE.
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM supplements WHERE id = ? AND user_id = ?`,
    [supplementId, userId],
  )
  return result.affectedRows > 0
}

export async function logSupplement(
  userId: number,
  supplementId: number,
  amount: number,
  takenAt?: string | null,
  note?: string | null,
): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO supplement_intake (user_id, supplement_id, amount, taken_at, note)
     VALUES (?, ?, ?, ?, ?)`,
    [
      userId,
      supplementId,
      amount,
      formatDateForMySQL(takenAt ? takenAt : new Date()),
      note ?? null,
    ],
  )
  return result.insertId
}

export async function hasTakenTodayServer(
  userId: number,
  supplementId: number,
): Promise<SupplementEntry | null> {
  const [rows] = await pool.execute<SupplementEntry[]>(
    `SELECT ${INTAKE_COLS} FROM supplement_intake
     WHERE user_id = ? AND supplement_id = ? AND DATE(taken_at) = CURDATE()
     ORDER BY taken_at DESC LIMIT 1`,
    [userId, supplementId],
  )
  return rows[0] ?? null
}

export async function getHistory(
  userId: number,
  supplementId: number,
  limit = 30,
): Promise<SupplementEntry[]> {
  const [rows] = await pool.execute<SupplementEntry[]>(
    `SELECT ${INTAKE_COLS} FROM supplement_intake
     WHERE user_id = ? AND supplement_id = ?
     ORDER BY taken_at DESC LIMIT ?`,
    [userId, supplementId, limit],
  )
  return rows
}

export async function getStreak(
  userId: number,
  supplementId: number,
): Promise<number> {
  const [rows] = await pool.execute<(RowDataPacket & { day: string })[]>(
    // Same 366-day cap as listSupplementSummaries — a streak longer than that
    // reports as 366.
    `SELECT DATE(taken_at) AS day FROM supplement_intake
     WHERE user_id = ? AND supplement_id = ?
       AND taken_at >= DATE_SUB(CURDATE(), INTERVAL 366 DAY)
     GROUP BY DATE(taken_at)
     ORDER BY day DESC`,
    [userId, supplementId],
  )
  return streakFromDays(rows.map((r) => r.day))
}

export async function deleteLogEntry(
  userId: number,
  supplementId: number,
  entryId: number,
): Promise<boolean> {
  // scoped to the supplement: an entry id from a different supplement is a 404,
  // not a delete of someone else's row
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM supplement_intake WHERE id = ? AND user_id = ? AND supplement_id = ?`,
    [entryId, userId, supplementId],
  )
  return result.affectedRows > 0
}
