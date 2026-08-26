import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { MacrosEntry, MacrosGoals } from "../tracking.types.js"
// Aliased to camelCase in SQL, so the query result is already the wire shape.
// `+ 0` forces the DECIMAL columns to come back as numbers rather than the
// strings mysql2 hands over for DECIMAL.
type MacrosIntakeRow = MacrosEntry & RowDataPacket

const MACROS_COLS = `id, name, protein + 0 AS protein, carbs + 0 AS carbs,
       fat + 0 AS fat, calories + 0 AS calories,
       COALESCE(error_margin, 0) + 0 AS errorMargin,
       time, DATE(taken_at) AS date, taken_at AS takenAt, note`


export async function logMacrosIntake(
  userId: number,
  name: string | null,
  protein: number | null,
  carbs: number | null,
  fat: number | null,
  calories: number | null,
  errorMargin: number,
  time: string,
  takenAt: string,
  note?: string | null,
): Promise<MacrosIntakeRow> {
  const ts = formatDateForMySQL(takenAt)
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO macros_intake (user_id, name, protein, carbs, fat, calories, error_margin, time, taken_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      name ?? null,
      protein ?? null,
      carbs ?? null,
      fat ?? null,
      calories ?? null,
      errorMargin ?? 0,
      time,
      ts,
      note ?? null,
    ],
  )
  const [rows] = await pool.execute<MacrosIntakeRow[]>(
    `SELECT ${MACROS_COLS} FROM macros_intake WHERE id = ?`,
    [result.insertId],
  )
  return rows[0]
}

export async function getMacrosHistory(
  userId: number,
  days = 30,
): Promise<MacrosEntry[]> {
  const [rows] = await pool.execute<MacrosIntakeRow[]>(
    `SELECT ${MACROS_COLS} FROM macros_intake
     WHERE user_id = ? AND taken_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     ORDER BY taken_at DESC`,
    [userId, days],
  )
  return rows
}

export async function setMacrosGoals(
  userId: number,
  goals: Partial<MacrosGoals>,
): Promise<Partial<MacrosGoals>> {
  // Atomic upsert — replaces the old SELECT + conditional INSERT/UPDATE pattern
  // which had a race condition when two requests fired simultaneously.
  await pool.execute(
    `INSERT INTO macros_goals (user_id, protein_goal, carbs_goal, fat_goal, calories_goal)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       protein_goal  = COALESCE(VALUES(protein_goal),  protein_goal),
       carbs_goal    = COALESCE(VALUES(carbs_goal),    carbs_goal),
       fat_goal      = COALESCE(VALUES(fat_goal),      fat_goal),
       calories_goal = COALESCE(VALUES(calories_goal), calories_goal),
       updated_at    = NOW()`,
    [
      userId,
      goals.protein ?? null,
      goals.carbs ?? null,
      goals.fat ?? null,
      goals.calories ?? null,
    ],
  )
  return goals
}

export async function deleteMacrosEntry(
  userId: number,
  entryId: number,
): Promise<boolean | null> {
  const [check] = await pool.execute<(RowDataPacket & { id: number })[]>(
    "SELECT id FROM macros_intake WHERE id = ? AND user_id = ?",
    [entryId, userId],
  )
  if (!check[0]) return null
  const [result] = await pool.execute<ResultSetHeader>(
    "DELETE FROM macros_intake WHERE id = ?",
    [entryId],
  )
  return (result as ResultSetHeader).affectedRows > 0
}
