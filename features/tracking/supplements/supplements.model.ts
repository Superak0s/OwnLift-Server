import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"

const mysqlTimeToSimple = (t: string): string =>
  t.toString().split(":").slice(0, 2).join(":")

const simpleTimeToMySQL = (t: string): string => {
  const [h = "00", m = "00"] = t.split(":")
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}:00`
}

export interface Supplement {
  id: number
  userId: number
  name: string
  unit: string
  defaultAmount: number
  reminderEnabled: boolean
  reminderTime: string | null
  color: string | null
  icon: string | null
  createdAt: Date
  updatedAt: Date
}

interface SupplementSummary {
  id: number
  name: string
  unit: string
  defaultAmount: number
  reminderEnabled: boolean
  reminderTime: string | null
  color: string | null
  icon: string | null
  takenToday: boolean
  streak: number
}

interface SupplementEntry {
  id: number
  supplementId: number
  amount: number
  takenAt: Date
  note: string | null
  createdAt: Date
}

interface SupplementRow extends RowDataPacket {
  id: number
  user_id: number
  name: string
  unit: string
  default_amount: string | number
  reminder_enabled: number
  reminder_time: string | null
  color: string | null
  icon: string | null
  created_at: Date
  updated_at: Date
}

interface SupplementLogRow extends RowDataPacket {
  id: number
  supplement_id: number
  user_id: number
  amount: string | number
  taken_at: Date
  note: string | null
  created_at: Date
}


function rowToSupplement(r: SupplementRow): Supplement {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    unit: r.unit,
    defaultAmount: parseFloat(String(r.default_amount)),
    reminderEnabled: r.reminder_enabled === 1,
    reminderTime: r.reminder_time ? mysqlTimeToSimple(r.reminder_time) : null,
    color: r.color,
    icon: r.icon,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToEntry(r: SupplementLogRow): SupplementEntry {
  return {
    id: r.id,
    supplementId: r.supplement_id,
    amount: parseFloat(String(r.amount)),
    takenAt: r.taken_at,
    note: r.note,
    createdAt: r.created_at,
  }
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
    `INSERT INTO supplements (user_id, name, unit, default_amount, reminder_enabled, reminder_time, color, icon)
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
  const supplement = await getSupplementById(userId, result.insertId)
  // createSupplement is always called after validation so the row must exist
  return supplement!
}

export async function getSupplementById(
  userId: number,
  supplementId: number,
): Promise<Supplement | null> {
  const [rows] = await pool.execute<SupplementRow[]>(
    `SELECT * FROM supplements WHERE id = ? AND user_id = ?`,
    [supplementId, userId],
  )
  return rows[0] ? rowToSupplement(rows[0]) : null
}

async function listSupplements(userId: number): Promise<Supplement[]> {
  const [rows] = await pool.execute<SupplementRow[]>(
    `SELECT * FROM supplements WHERE user_id = ? ORDER BY name ASC`,
    [userId],
  )
  return rows.map(rowToSupplement)
}

/**
 * Returns every supplement enriched with today's taken status and current
 * streak. One query for the supplement list, one for every log day across
 * all of them (grouped/computed in JS) — flat cost regardless of how many
 * supplements the user has, instead of 2 extra round-trips per supplement.
 */
export async function listSupplementSummaries(
  userId: number,
): Promise<SupplementSummary[]> {
  const supplements = await listSupplements(userId)
  if (supplements.length === 0) return []

  const [rows] = await pool.execute<(RowDataPacket & { supplement_id: number; day: string })[]>(
    // A streak breaks at the first missing day, so anything older than the
    // longest streak this can report is dead weight — cap the scan at a year
    // instead of reading every log row the user has ever written.
    `SELECT supplement_id, DATE(taken_at) AS day
     FROM supplement_log
     WHERE user_id = ? AND taken_at >= DATE_SUB(CURDATE(), INTERVAL 366 DAY)
     GROUP BY supplement_id, DATE(taken_at)
     ORDER BY supplement_id, day DESC`,
    [userId],
  )

  const daysBySupplement = new Map<number, string[]>()
  for (const row of rows) {
    const list = daysBySupplement.get(row.supplement_id)
    if (list) list.push(row.day)
    else daysBySupplement.set(row.supplement_id, [row.day])
  }

  const today = utcDay(new Date())

  return supplements.map((s) => {
    const days = daysBySupplement.get(s.id) ?? []
    return {
      id: s.id,
      name: s.name,
      unit: s.unit,
      defaultAmount: s.defaultAmount,
      reminderEnabled: s.reminderEnabled,
      reminderTime: s.reminderTime,
      color: s.color,
      icon: s.icon,
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
  // Build SET clause dynamically so we only touch provided fields
  const setClauses: string[] = []
  const values: (string | number | null)[] = []

  if (fields.name !== undefined) {
    setClauses.push("name = ?")
    values.push(fields.name)
  }
  if (fields.unit !== undefined) {
    setClauses.push("unit = ?")
    values.push(fields.unit)
  }
  if (fields.defaultAmount !== undefined) {
    setClauses.push("default_amount = ?")
    values.push(fields.defaultAmount)
  }
  if (fields.reminderEnabled !== undefined) {
    setClauses.push("reminder_enabled = ?")
    values.push(fields.reminderEnabled ? 1 : 0)
  }
  if (fields.reminderTime !== undefined) {
    setClauses.push("reminder_time = ?")
    values.push(
      fields.reminderTime ? simpleTimeToMySQL(fields.reminderTime) : null,
    )
  }
  if (fields.color !== undefined) {
    setClauses.push("color = ?")
    values.push(fields.color)
  }
  if (fields.icon !== undefined) {
    setClauses.push("icon = ?")
    values.push(fields.icon)
  }

  if (setClauses.length === 0) return getSupplementById(userId, supplementId)

  values.push(supplementId, userId)
  await pool.execute(
    `UPDATE supplements SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`,
    values,
  )
  return getSupplementById(userId, supplementId)
}

export async function deleteSupplement(
  userId: number,
  supplementId: number,
): Promise<boolean> {
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
    `INSERT INTO supplement_log (supplement_id, user_id, amount, taken_at, note)
     VALUES (?, ?, ?, ?, ?)`,
    [
      supplementId,
      userId,
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
  const [rows] = await pool.execute<SupplementLogRow[]>(
    `SELECT id, supplement_id, user_id, amount, taken_at, note, created_at
     FROM supplement_log
     WHERE user_id = ? AND supplement_id = ? AND DATE(taken_at) = CURDATE()
     ORDER BY taken_at DESC LIMIT 1`,
    [userId, supplementId],
  )
  return rows[0] ? rowToEntry(rows[0]) : null
}

export async function getHistory(
  userId: number,
  supplementId: number,
  limit = 30,
): Promise<SupplementEntry[]> {
  const [rows] = await pool.execute<SupplementLogRow[]>(
    `SELECT id, supplement_id, user_id, amount, taken_at, note, created_at
     FROM supplement_log
     WHERE user_id = ? AND supplement_id = ?
     ORDER BY taken_at DESC LIMIT ?`,
    [userId, supplementId, limit],
  )
  return rows.map(rowToEntry)
}

export async function getStreak(
  userId: number,
  supplementId: number,
): Promise<number> {
  const [rows] = await pool.execute<(RowDataPacket & { day: string })[]>(
    // Same 366-day cap as listSupplementSummaries — a streak longer than that
    // reports as 366.
    `SELECT DATE(taken_at) AS day
     FROM supplement_log
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
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM supplement_log WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  return result.affectedRows > 0
}
