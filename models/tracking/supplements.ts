// src/models/tracking/supplements.ts
import { pool } from "../../config/database"
import { query as dbQuery } from "../../config/database"
import type { RowDataPacket } from "mysql2"
import type { InsertResult } from "../../types"
import {
  formatDateForMySQL,
  simpleTimeToMySQL,
  mysqlTimeToSimple,
} from "../utils/dateHelpers"
import type {
  Supplement,
  SupplementSummary,
  SupplementEntry,
  SupplementLocation,
  AtLocationResult,
} from "../../types/index"

export type {
  Supplement,
  SupplementSummary,
  SupplementEntry,
  SupplementLocation,
  AtLocationResult,
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface SupplementRow extends RowDataPacket {
  id: number
  user_id: number
  name: string
  unit: string
  default_amount: string | number
  reminder_enabled: number
  reminder_time: string | null
  location_reminder_enabled: number
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

interface SupplementLocationRow extends RowDataPacket {
  id: number
  supplement_id: number
  user_id: number
  latitude: number
  longitude: number
  address: string
  radius: number
  enabled: number
  created_at: Date
  updated_at: Date
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToSupplement(r: SupplementRow): Supplement {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    unit: r.unit,
    defaultAmount: parseFloat(String(r.default_amount)),
    reminderEnabled: r.reminder_enabled === 1,
    reminderTime: r.reminder_time ? mysqlTimeToSimple(r.reminder_time) : null,
    locationReminderEnabled: r.location_reminder_enabled === 1,
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

function rowToLocation(r: SupplementLocationRow): SupplementLocation {
  return {
    id: r.id,
    supplementId: r.supplement_id,
    latitude: r.latitude,
    longitude: r.longitude,
    address: r.address,
    radius: r.radius,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ─── Supplement CRUD ──────────────────────────────────────────────────────────

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
  const [result] = await pool.execute<InsertResult>(
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
  const [rows] = await dbQuery<SupplementRow[]>(
    `SELECT * FROM supplements WHERE id = ? AND user_id = ?`,
    [supplementId, userId],
  )
  return rows[0] ? rowToSupplement(rows[0]) : null
}

export async function listSupplements(userId: number): Promise<Supplement[]> {
  const [rows] = await dbQuery<SupplementRow[]>(
    `SELECT * FROM supplements WHERE user_id = ? ORDER BY name ASC`,
    [userId],
  )
  return rows.map(rowToSupplement)
}

/**
 * Returns every supplement enriched with today's taken status and current streak.
 * Runs two extra queries (today check + streak per supplement) but keeps the
 * model simple — use the dedicated endpoints for high-frequency polling.
 */
export async function listSupplementSummaries(
  userId: number,
): Promise<SupplementSummary[]> {
  const supplements = await listSupplements(userId)
  return Promise.all(
    supplements.map(async (s) => {
      const [takenToday, streak] = await Promise.all([
        hasTakenTodayServer(userId, s.id),
        getStreak(userId, s.id),
      ])
      return {
        id: s.id,
        name: s.name,
        unit: s.unit,
        defaultAmount: s.defaultAmount,
        reminderEnabled: s.reminderEnabled,
        reminderTime: s.reminderTime,
        locationReminderEnabled: s.locationReminderEnabled,
        color: s.color,
        icon: s.icon,
        takenToday: !!takenToday,
        streak,
      }
    }),
  )
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
    locationReminderEnabled?: boolean
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
  if (fields.locationReminderEnabled !== undefined) {
    setClauses.push("location_reminder_enabled = ?")
    values.push(fields.locationReminderEnabled ? 1 : 0)
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
  const [result] = await pool.execute<InsertResult>(
    `DELETE FROM supplements WHERE id = ? AND user_id = ?`,
    [supplementId, userId],
  )
  return result.affectedRows > 0
}

// ─── Log ──────────────────────────────────────────────────────────────────────

export async function logSupplement(
  userId: number,
  supplementId: number,
  amount: number,
  takenAt?: string | null,
  note?: string | null,
): Promise<number> {
  const [result] = await pool.execute<InsertResult>(
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
  const [rows] = await dbQuery<SupplementLogRow[]>(
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
  const [rows] = await dbQuery<SupplementLogRow[]>(
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
  const [rows] = await dbQuery<(RowDataPacket & { day: Date })[]>(
    `SELECT DATE(taken_at) AS day
     FROM supplement_log
     WHERE user_id = ? AND supplement_id = ?
     GROUP BY DATE(taken_at)
     ORDER BY day DESC`,
    [userId, supplementId],
  )
  if (!rows.length) return 0

  let streak = 0
  let expected = new Date()
  expected.setHours(0, 0, 0, 0)

  for (const row of rows) {
    const day = new Date(row.day)
    day.setHours(0, 0, 0, 0)
    if (
      streak === 0 &&
      (day.getTime() === expected.getTime() ||
        day.getTime() === expected.getTime() - 86400000)
    ) {
      streak++
      expected = new Date(day.getTime() - 86400000)
      continue
    }
    if (day.getTime() === expected.getTime()) {
      streak++
      expected = new Date(day.getTime() - 86400000)
    } else break
  }
  return streak
}

export async function deleteLogEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<InsertResult>(
    `DELETE FROM supplement_log WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  return result.affectedRows > 0
}

// ─── Location ─────────────────────────────────────────────────────────────────

export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371e3
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δφ = ((lat2 - lat1) * Math.PI) / 180
  const Δλ = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export async function saveLocation(
  userId: number,
  supplementId: number,
  latitude: number,
  longitude: number,
  address: string,
  radius: number,
): Promise<SupplementLocation> {
  await pool.execute(
    `INSERT INTO supplement_locations (supplement_id, user_id, latitude, longitude, address, radius)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       latitude  = VALUES(latitude),
       longitude = VALUES(longitude),
       address   = VALUES(address),
       radius    = VALUES(radius),
       updated_at = NOW()`,
    [supplementId, userId, latitude, longitude, address, radius],
  )
  return (await getLocation(userId, supplementId))!
}

export async function getLocation(
  userId: number,
  supplementId: number,
): Promise<SupplementLocation | null> {
  const [rows] = await pool.execute<SupplementLocationRow[]>(
    `SELECT * FROM supplement_locations WHERE supplement_id = ? AND user_id = ?`,
    [supplementId, userId],
  )
  return rows[0] ? rowToLocation(rows[0]) : null
}

export async function toggleLocation(
  userId: number,
  supplementId: number,
  enabled: boolean,
): Promise<SupplementLocation> {
  const existing = await getLocation(userId, supplementId)
  if (!existing) throw new Error("No reminder location set")

  await pool.execute(
    `UPDATE supplement_locations SET enabled = ?, updated_at = NOW()
     WHERE supplement_id = ? AND user_id = ?`,
    [enabled ? 1 : 0, supplementId, userId],
  )

  // Also sync the flag on the parent supplement row
  await pool.execute(
    `UPDATE supplements SET location_reminder_enabled = ? WHERE id = ? AND user_id = ?`,
    [enabled ? 1 : 0, supplementId, userId],
  )

  return { ...existing, enabled }
}

export async function checkIfAtLocation(
  userId: number,
  supplementId: number,
  currentLat: number,
  currentLng: number,
): Promise<AtLocationResult> {
  const [rows] = await pool.execute<SupplementLocationRow[]>(
    `SELECT * FROM supplement_locations WHERE supplement_id = ? AND user_id = ? AND enabled = 1`,
    [supplementId, userId],
  )
  if (!rows[0]) return { withinRadius: false, reason: "no_location_set" }
  const l = rows[0]
  const distance = calculateDistance(
    currentLat,
    currentLng,
    l.latitude,
    l.longitude,
  )
  return {
    withinRadius: distance <= l.radius,
    distance: Math.round(distance),
    radius: l.radius,
    address: l.address,
  }
}

export async function deleteLocation(
  userId: number,
  supplementId: number,
): Promise<boolean> {
  const [result] = await pool.execute<InsertResult>(
    `DELETE FROM supplement_locations WHERE supplement_id = ? AND user_id = ?`,
    [supplementId, userId],
  )
  if (result.affectedRows > 0) {
    await pool.execute(
      `UPDATE supplements SET location_reminder_enabled = 0 WHERE id = ? AND user_id = ?`,
      [supplementId, userId],
    )
    return true
  }
  return false
}
