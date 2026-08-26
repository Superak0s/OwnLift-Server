import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { ValidationError } from "@/middleware/errorHandler.js"

// Aliased to camelCase in SQL, so the query result is already the wire shape.
interface CustomMeasurementType extends RowDataPacket {
  id: number
  keyName: string
  label: string
  unit: string | null
  createdAt: Date
  updatedAt: Date
}

const TYPE_COLS = `id, key_name AS keyName, label, unit,
       created_at AS createdAt, updated_at AS updatedAt`

export async function createMeasurementType(
  userId: number,
  keyName: string,
  label: string,
  unit?: string | null,
): Promise<CustomMeasurementType> {
  if (!keyName || !label) throw new ValidationError("keyName and label are required")
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO measurement_custom_types (user_id, key_name, label, unit) VALUES (?, ?, ?, ?)`,
    [userId, keyName, label, unit ?? null],
  )
  const [rows] = await pool.execute<CustomMeasurementType[]>(
    `SELECT ${TYPE_COLS} FROM measurement_custom_types WHERE id = ?`,
    [result.insertId],
  )
  return rows[0]
}

export async function getMeasurementTypes(userId: number): Promise<CustomMeasurementType[]> {
  const [rows] = await pool.execute<CustomMeasurementType[]>(
    `SELECT ${TYPE_COLS} FROM measurement_custom_types
     WHERE user_id = ? ORDER BY created_at ASC`,
    [userId],
  )
  return rows
}

export async function logCustomMeasurement(
  userId: number,
  typeId: number,
  value: number,
  measuredAt?: string | null,
  note?: string | null,
): Promise<number> {
  if (isNaN(value)) throw new ValidationError("Value must be a number")
  const [typeRows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM measurement_custom_types WHERE id = ? AND user_id = ?`,
    [typeId, userId],
  )
  if (typeRows.length === 0) throw new ValidationError("Measurement type not found")
  const ts = formatDateForMySQL(measuredAt ? measuredAt : new Date())
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO measurement_custom_values (user_id, type_id, value, measured_at, note) VALUES (?, ?, ?, ?, ?)`,
    [userId, typeId, value, ts, note ?? null],
  )
  return result.insertId
}
