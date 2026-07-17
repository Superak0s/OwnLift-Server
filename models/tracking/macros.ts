// src/models/tracking/macros.ts
import { pool } from "../../config/database"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { InsertResult } from "../../types"
import type {
  MacrosEntry,
  MacrosStat,
  MacrosGoals,
  DailySummary,
} from "../../types"

export type { MacrosEntry, MacrosStat, MacrosGoals, DailySummary }

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface MacrosIntakeRow extends RowDataPacket {
  id: number
  name: string | null
  protein: string | null
  carbs: string | null
  fat: string | null
  calories: string | null
  error_margin: string | number
  time: string
  taken_at: Date
  note: string | null
}

interface MacrosGoalsRow extends RowDataPacket {
  protein_goal: string | null
  carbs_goal: string | null
  fat_goal: string | null
  calories_goal: string | null
}

interface DailyAggRow extends RowDataPacket {
  date: string
  total_protein: string | null
  total_carbs: string | null
  total_fat: string | null
  total_calories: string | null
  entry_count: number
  avg_error: string | null
}


// ─── Queries ──────────────────────────────────────────────────────────────────

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
  const ts = new Date(takenAt).toISOString().slice(0, 19).replace("T", " ")
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
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
    "SELECT * FROM macros_intake WHERE id = ?",
    [(result as unknown as InsertResult).insertId],
  )
  return rows[0]
}

export async function getMacrosHistory(
  userId: number,
  days = 30,
): Promise<MacrosEntry[]> {
  const [rows] = await pool.execute<MacrosIntakeRow[]>(
    `SELECT * FROM macros_intake WHERE user_id = ? AND taken_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ORDER BY taken_at DESC`,
    [userId, days],
  )
  return rows.map(formatEntry)
}

export async function getMacrosStatsForDate(
  userId: number,
  date: string,
): Promise<DailySummary> {
  const [entries] = await pool.execute<MacrosIntakeRow[]>(
    `SELECT * FROM macros_intake WHERE user_id = ? AND DATE(taken_at) = ? ORDER BY time ASC`,
    [userId, date],
  )

  const avgErr =
    entries.length > 0
      ? entries.reduce(
          (s, e) => s + (parseFloat(String(e.error_margin)) || 0),
          0,
        ) / entries.length
      : 0

  const sum = (field: keyof MacrosIntakeRow) =>
    entries.reduce(
      (s, e) => (e[field] != null ? s + parseFloat(String(e[field])) : s),
      0,
    )
  const hasAny = (field: keyof MacrosIntakeRow) =>
    entries.some((e) => e[field] != null)
  const applyMargin = (val: number) => ({
    min: val * (1 - avgErr / 100),
    max: val * (1 + avgErr / 100),
  })
  const goals = await getMacrosGoals(userId)

  const makeStat = (
    field: keyof MacrosIntakeRow,
    goal: number,
  ): MacrosStat | null => {
    if (!hasAny(field)) return null
    const total = sum(field)
    return {
      total,
      ...applyMargin(total),
      goal,
      percentage: (total / goal) * 100,
    }
  }

  return {
    date,
    protein: makeStat("protein", goals.protein),
    carbs: makeStat("carbs", goals.carbs),
    fat: makeStat("fat", goals.fat),
    calories: makeStat("calories", goals.calories),
    entries: entries.length,
    entriesList: entries.map((e) => ({
      id: e.id,
      name: e.name,
      protein: e.protein != null ? parseFloat(String(e.protein)) : null,
      carbs: e.carbs != null ? parseFloat(String(e.carbs)) : null,
      fat: e.fat != null ? parseFloat(String(e.fat)) : null,
      calories: e.calories != null ? parseFloat(String(e.calories)) : null,
      time: e.time,
      note: e.note,
    })),
  }
}

export async function getMacrosGoals(userId: number): Promise<MacrosGoals> {
  const [rows] = await pool.execute<MacrosGoalsRow[]>(
    "SELECT * FROM macros_goals WHERE user_id = ?",
    [userId],
  )
  return {
    protein: parseFloat(String(rows[0]?.protein_goal)) || 150,
    carbs: parseFloat(String(rows[0]?.carbs_goal)) || 250,
    fat: parseFloat(String(rows[0]?.fat_goal)) || 65,
    calories: parseFloat(String(rows[0]?.calories_goal)) || 2000,
  }
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

function withMargin(val: string | number | null, err: string | number) {
  const n = val != null ? parseFloat(String(val)) : null
  const e = parseFloat(String(err))
  return n != null
    ? {
        total: n,
        minEstimate: n * (1 - e / 100),
        maxEstimate: n * (1 + e / 100),
      }
    : null
}

export async function getWeeklySummary(userId: number) {
  const [rows] = await pool.execute<DailyAggRow[]>(
    `SELECT DATE(taken_at) AS date, SUM(protein) AS total_protein, SUM(carbs) AS total_carbs,
       SUM(fat) AS total_fat, SUM(calories) AS total_calories, COUNT(*) AS entry_count, AVG(error_margin) AS avg_error
     FROM macros_intake WHERE user_id = ? AND taken_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
     GROUP BY DATE(taken_at) ORDER BY date DESC`,
    [userId],
  )
  return rows.map((d) => ({
    date: d.date,
    entries: d.entry_count,
    protein: withMargin(d.total_protein, d.avg_error ?? 0),
    carbs: withMargin(d.total_carbs, d.avg_error ?? 0),
    fat: withMargin(d.total_fat, d.avg_error ?? 0),
    calories: withMargin(d.total_calories, d.avg_error ?? 0),
  }))
}

interface MonthlyAggRow extends RowDataPacket {
  date: string
  p: string | null
  c: string | null
  f: string | null
  cal: string | null
  entry_count: number
}

export async function getMonthlySummary(userId: number) {
  const [rows] = await pool.execute<MonthlyAggRow[]>(
    `SELECT DATE(taken_at) AS date, SUM(protein) AS p, SUM(carbs) AS c, SUM(fat) AS f,
       SUM(calories) AS cal, COUNT(*) AS entry_count
     FROM macros_intake WHERE user_id = ? AND taken_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
     GROUP BY DATE(taken_at) ORDER BY date DESC`,
    [userId],
  )
  const count = rows.length || 1
  const totals = rows.reduce(
    (acc, d) => ({
      protein: acc.protein + (parseFloat(String(d.p)) || 0),
      carbs: acc.carbs + (parseFloat(String(d.c)) || 0),
      fat: acc.fat + (parseFloat(String(d.f)) || 0),
      calories: acc.calories + (parseFloat(String(d.cal)) || 0),
    }),
    { protein: 0, carbs: 0, fat: 0, calories: 0 },
  )
  return {
    summary: rows.map((d) => ({
      date: d.date,
      protein: d.p,
      carbs: d.c,
      fat: d.f,
      calories: d.cal,
      entries: d.entry_count,
    })),
    averageDaily: {
      protein: totals.protein / count,
      carbs: totals.carbs / count,
      fat: totals.fat / count,
      calories: totals.calories / count,
    },
  }
}

function formatEntry(e: MacrosIntakeRow): MacrosEntry {
  return {
    id: e.id,
    name: e.name,
    protein: e.protein != null ? parseFloat(String(e.protein)) : null,
    carbs: e.carbs != null ? parseFloat(String(e.carbs)) : null,
    fat: e.fat != null ? parseFloat(String(e.fat)) : null,
    calories: e.calories != null ? parseFloat(String(e.calories)) : null,
    errorMargin: parseFloat(String(e.error_margin)) || 0,
    time: e.time,
    date: String(e.taken_at).split(" ")[0],
    takenAt: e.taken_at,
    note: e.note,
  }
}
