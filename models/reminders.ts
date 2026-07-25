// src/models/reminders.ts
// User reminders for various health tracking activities

import { pool } from "../config/database"
import { query as dbQuery } from "../config/database"
import type { RowDataPacket } from "mysql2"
import type { InsertResult } from "../types"
import { ValidationError } from "../middleware/errorHandler"

export type ReminderType = "weigh_in" | "hydration" | "sleep" | "measurements" | "menstrual"
export type ReminderFrequency = "daily" | "weekly" | "custom"

export interface UserReminder {
  id: number
  reminderType: ReminderType
  enabled: boolean
  frequency: ReminderFrequency
  timeOfDay?: string | null // HH:MM format
  dayOfWeek?: number | null // 0-6 (Sun-Sat)
  createdAt: Date
  updatedAt: Date
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface ReminderRow extends RowDataPacket {
  id: number
  reminder_type: ReminderType
  enabled: number
  frequency: ReminderFrequency
  time_of_day: string | null
  day_of_week: number | null
  created_at: Date
  updated_at: Date
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function createOrUpdateReminder(
  userId: number,
  reminderType: ReminderType,
  enabled: boolean,
  frequency: ReminderFrequency = "daily",
  timeOfDay?: string | null,
  dayOfWeek?: number | null,
): Promise<number> {
  // Validate frequency
  if (!["daily", "weekly", "custom"].includes(frequency)) {
    throw new ValidationError("Frequency must be: daily, weekly, or custom")
  }

  // Validate time format (HH:MM)
  if (timeOfDay) {
    const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/
    if (!timeRegex.test(timeOfDay)) {
      throw new ValidationError("Time must be in HH:MM format (00:00 - 23:59)")
    }
  }

  // Validate day of week
  if (dayOfWeek !== null && dayOfWeek !== undefined) {
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw new ValidationError("Day of week must be 0-6 (Sunday-Saturday)")
    }
  }

  // Check if reminder already exists
  const [existing] = await dbQuery<ReminderRow[]>(
    `SELECT id FROM user_reminders WHERE user_id = ? AND reminder_type = ?`,
    [userId, reminderType],
  )

  if (existing[0]) {
    // Update existing
    const [result] = await pool.execute<
      InsertResult & { constructor: { name: string } }
    >(
      `UPDATE user_reminders SET enabled = ?, frequency = ?, time_of_day = ?, day_of_week = ?, updated_at = NOW()
       WHERE user_id = ? AND reminder_type = ?`,
      [enabled ? 1 : 0, frequency, timeOfDay ?? null, dayOfWeek ?? null, userId, reminderType],
    )
    return existing[0].id
  } else {
    // Insert new
    const [result] = await pool.execute<
      InsertResult & { constructor: { name: string } }
    >(
      `INSERT INTO user_reminders (user_id, reminder_type, enabled, frequency, time_of_day, day_of_week)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, reminderType, enabled ? 1 : 0, frequency, timeOfDay ?? null, dayOfWeek ?? null],
    )
    return (result as unknown as InsertResult).insertId
  }
}

export async function getReminder(
  userId: number,
  reminderType: ReminderType,
): Promise<UserReminder | null> {
  const [rows] = await dbQuery<ReminderRow[]>(
    `SELECT id, reminder_type, enabled, frequency, time_of_day, day_of_week, created_at, updated_at
     FROM user_reminders WHERE user_id = ? AND reminder_type = ?`,
    [userId, reminderType],
  )
  return rows[0] ? formatReminder(rows[0]) : null
}

export async function getAllReminders(userId: number): Promise<UserReminder[]> {
  const [rows] = await dbQuery<ReminderRow[]>(
    `SELECT id, reminder_type, enabled, frequency, time_of_day, day_of_week, created_at, updated_at
     FROM user_reminders WHERE user_id = ? ORDER BY reminder_type`,
    [userId],
  )
  return rows.map(formatReminder)
}

export async function getEnabledReminders(userId: number): Promise<UserReminder[]> {
  const [rows] = await dbQuery<ReminderRow[]>(
    `SELECT id, reminder_type, enabled, frequency, time_of_day, day_of_week, created_at, updated_at
     FROM user_reminders WHERE user_id = ? AND enabled = 1 ORDER BY reminder_type`,
    [userId],
  )
  return rows.map(formatReminder)
}

export async function toggleReminder(
  userId: number,
  reminderType: ReminderType,
  enabled: boolean,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `UPDATE user_reminders SET enabled = ?, updated_at = NOW() WHERE user_id = ? AND reminder_type = ?`,
    [enabled ? 1 : 0, userId, reminderType],
  )
  return (result as unknown as InsertResult).affectedRows > 0
}

export async function deleteReminder(
  userId: number,
  reminderType: ReminderType,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `DELETE FROM user_reminders WHERE user_id = ? AND reminder_type = ?`,
    [userId, reminderType],
  )
  return (result as unknown as InsertResult).affectedRows > 0
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatReminder(row: ReminderRow): UserReminder {
  return {
    id: row.id,
    reminderType: row.reminder_type,
    enabled: !!row.enabled,
    frequency: row.frequency,
    timeOfDay: row.time_of_day,
    dayOfWeek: row.day_of_week,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
