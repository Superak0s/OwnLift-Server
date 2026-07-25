// src/models/tracking/customMeasurements.ts
// Custom measurement types and values (user-defined measurements)

import { pool } from "../../config/database"
import { query as dbQuery } from "../../config/database"
import type { RowDataPacket } from "mysql2"
import type { InsertResult } from "../../types"
import { formatDateForMySQL } from "../utils/dateHelpers"
import { ValidationError } from "../../middleware/errorHandler"

// DB row shapes
interface MeasurementTypeRow extends RowDataPacket {
  id: number
  key_name: string
  label: string
  unit: string | null
  created_at: Date
  updated_at: Date
}

interface MeasurementValueRow extends RowDataPacket {
  id: number
  type_id: number
  type_label: string
  value: string | number
  measured_at: Date
  note: string | null
  created_at: Date
}

export interface CustomMeasurementType {
  id: number
  keyName: string
  label: string
  unit?: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CustomMeasurementValue {
  id: number
  typeId: number
  typeLabel: string
  value: number
  measuredAt: Date
  note?: string | null
  createdAt: Date
}

export async function createMeasurementType(
  userId: number,
  keyName: string,
  label: string,
  unit?: string | null,
): Promise<CustomMeasurementType> {
  if (!keyName || !label) throw new ValidationError("keyName and label are required")
  const [result] = await pool.execute<InsertResult>(
    `INSERT INTO measurement_custom_types (user_id, key_name, label, unit) VALUES (?, ?, ?, ?)`,
    [userId, keyName, label, unit ?? null],
  )
  const insertId = (result as unknown as InsertResult).insertId
  const [rows] = await dbQuery<MeasurementTypeRow[]>(
    `SELECT id, key_name, label, unit, created_at, updated_at FROM measurement_custom_types WHERE id = ?`,
    [insertId],
  )
  const r = rows[0]
  return {
    id: r.id,
    keyName: r.key_name,
    label: r.label,
    unit: r.unit,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function getMeasurementTypes(userId: number): Promise<CustomMeasurementType[]> {
  const [rows] = await dbQuery<MeasurementTypeRow[]>(
    `SELECT id, key_name, label, unit, created_at, updated_at FROM measurement_custom_types WHERE user_id = ? ORDER BY created_at ASC`,
    [userId],
  )
  return rows.map((r) => ({
    id: r.id,
    keyName: r.key_name,
    label: r.label,
    unit: r.unit,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export async function deleteMeasurementType(userId: number, typeId: number): Promise<boolean> {
  const [result] = await pool.execute<InsertResult>(
    `DELETE FROM measurement_custom_types WHERE id = ? AND user_id = ?`,
    [typeId, userId],
  )
  return (result as unknown as InsertResult).affectedRows > 0
}

export async function logCustomMeasurement(
  userId: number,
  typeId: number,
  value: number,
  measuredAt?: string | null,
  note?: string | null,
): Promise<number> {
  if (isNaN(value)) throw new ValidationError("Value must be a number")
  const ts = formatDateForMySQL(measuredAt ? measuredAt : new Date())
  const [result] = await pool.execute<InsertResult>(
    `INSERT INTO measurement_custom_values (user_id, type_id, value, measured_at, note) VALUES (?, ?, ?, ?, ?)`,
    [userId, typeId, value, ts, note ?? null],
  )
  return (result as unknown as InsertResult).insertId
}

export async function getCustomMeasurementsForDate(userId: number, date: string): Promise<CustomMeasurementValue[]> {
  const [rows] = await dbQuery<MeasurementValueRow[]>(
    `SELECT v.id, v.type_id, t.label AS type_label, v.value, v.measured_at, v.note, v.created_at
     FROM measurement_custom_values v
     JOIN measurement_custom_types t ON t.id = v.type_id
     WHERE v.user_id = ? AND DATE(v.measured_at) = ? ORDER BY v.measured_at DESC`,
    [userId, date],
  )
  return rows.map((r) => ({
    id: r.id,
    typeId: r.type_id,
    typeLabel: r.type_label,
    value: parseFloat(String(r.value)),
    measuredAt: r.measured_at,
    note: r.note,
    createdAt: r.created_at,
  }))
}

export async function getMeasurementValues(userId: number, typeId: number, limit = 90): Promise<CustomMeasurementValue[]> {
  const [rows] = await dbQuery<MeasurementValueRow[]>(
    `SELECT v.id, v.type_id, t.label AS type_label, v.value, v.measured_at, v.note, v.created_at
     FROM measurement_custom_values v
     JOIN measurement_custom_types t ON t.id = v.type_id
     WHERE v.user_id = ? AND v.type_id = ? ORDER BY v.measured_at DESC LIMIT ?`,
    [userId, typeId, limit],
  )
  return rows.map((r) => ({
    id: r.id,
    typeId: r.type_id,
    typeLabel: r.type_label,
    value: parseFloat(String(r.value)),
    measuredAt: r.measured_at,
    note: r.note,
    createdAt: r.created_at,
  }))
}
