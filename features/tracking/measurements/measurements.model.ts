// The one table every scalar body metric lives in.
//
// body_weight, body_measurements, hydration_log, body_fat_measurements and
// measurement_custom_values were five tables of identical shape — one number,
// per user, per timestamp, charted over time — with five sets of near-identical
// log/history/delete functions. This module is that table and those functions;
// the feature models above it only pick a metric key and shape the response.
//
// Hold the line drawn in schema.sql: a *scalar* series belongs here, anything
// with internal structure (a set, a photo, a cycle, a meal) keeps its own table.

import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { ValidationError, ConflictError } from "@/middleware/errorHandler.js"

/**
 * Built-in metric keys. A user-defined key comes from metric_definitions
 * instead; these need no row there because the client already knows their
 * labels and units.
 *
 * Adding a tracked metric is adding a line here — it is no longer DDL.
 */
export const METRICS = {
  weightKg: "weight_kg",
  bodyFatPct: "body_fat_pct",
  waistCm: "waist_cm",
  neckCm: "neck_cm",
  hipCm: "hip_cm",
  armLeftCm: "arm_left_cm",
  armRightCm: "arm_right_cm",
  chestCm: "chest_cm",
  waterMl: "water_ml",
} as const

export const BUILT_IN_METRICS: readonly string[] = Object.values(METRICS)

/**
 * A metric key is used as a SQL identifier by the pivot in getMetricGroups, so
 * it is not enough for it to be *known* — it has to be spellable. Everything
 * that can put a key into `measurements.metric` goes through here or through
 * requireKnownMetric, and ck_md_key_name repeats the rule in the DDL.
 */
const METRIC_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

function requireMetricKeyShape(metric: string): void {
  if (!METRIC_KEY_PATTERN.test(metric))
    throw new ValidationError(
      `Invalid metric key: ${metric}. Use lowercase letters, digits and ` +
        `underscores, starting with a letter, up to 64 characters.`,
    )
}

export interface MetricSample {
  metric: string
  value: number
}

export interface MetricEntry extends RowDataPacket {
  id: number
  metric: string
  value: number
  measuredAt: Date | string
  note: string | null
  createdAt: Date | string
}

const ENTRY_COLS = `id, metric, value, measured_at AS measuredAt, note,
  created_at AS createdAt`

/**
 * Write one or more samples under a single shared `measured_at`, which is what
 * makes them one measuring session: the body-fat log writes body_fat_pct next to
 * the circumferences it was computed from, and those circumferences then appear
 * on their own charts for free.
 *
 * Returns the id of the first row inserted — the handle the delete endpoints use
 * to find the group again.
 */
export async function logMetrics(
  userId: number,
  samples: MetricSample[],
  measuredAt?: string | Date | null,
  note?: string | null,
): Promise<number> {
  if (samples.length === 0)
    throw new ValidationError("At least one measurement is required")
  for (const s of samples) {
    // ck_m_value enforces this too; catching it here gives the user the metric
    // name instead of a driver-level constraint message.
    if (!Number.isFinite(s.value) || s.value <= 0)
      throw new ValidationError(`${s.metric} must be a number greater than 0`)
  }

  const ts = formatDateForMySQL(measuredAt ? measuredAt : new Date())
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO measurements (user_id, metric, value, measured_at, note) VALUES
     ${samples.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
    samples.flatMap((s) => [userId, s.metric, s.value, ts, note ?? null]),
  )
  return result.insertId
}

export async function getMetricHistory(
  userId: number,
  metric: string,
  limit: number,
): Promise<MetricEntry[]> {
  const [rows] = await pool.execute<MetricEntry[]>(
    `SELECT ${ENTRY_COLS} FROM measurements
     WHERE user_id = ? AND metric = ? ORDER BY measured_at DESC LIMIT ?`,
    [userId, metric, limit],
  )
  return rows
}

export async function getLatestMetric(
  userId: number,
  metric: string,
): Promise<MetricEntry | null> {
  const rows = await getMetricHistory(userId, metric, 1)
  return rows[0] ?? null
}

export async function deleteMetricEntry(
  userId: number,
  entryId: number,
  metric: string,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM measurements WHERE id = ? AND user_id = ? AND metric = ?`,
    [entryId, userId, metric],
  )
  return result.affectedRows > 0
}

/** Delete one measurement by id, whatever metric it holds. */
export async function deleteMeasurement(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM measurements WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  return result.affectedRows > 0
}

/**
 * One row per measuring session, with the requested metrics pivoted into
 * columns named by their wire alias. `require` names the metric that has to be
 * present for a session to count — the body-fat history wants sessions that
 * produced a percentage, not every session that happened to record a waist.
 */
export async function getMetricGroups(
  userId: number,
  metrics: Record<string, string>,
  limit: number,
  require?: string,
): Promise<RowDataPacket[]> {
  const aliases = Object.keys(metrics)
  // The aliases land between backticks, so they must be identifier-shaped.
  // requireKnownMetric already rejects anything else at the request boundary;
  // this is the belt to that brace.
  aliases.forEach(requireMetricKeyShape)
  const pivot = aliases
    .map((a) => `MAX(CASE WHEN metric = ? THEN value END) AS \`${a}\``)
    .join(",\n            ")
  const keys = aliases.map((a) => metrics[a])

  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT MIN(id) AS id, measured_at AS measuredAt, MAX(note) AS note,
            ${pivot}
     FROM measurements
     WHERE user_id = ? AND metric IN (${keys.map(() => "?").join(", ")})
     GROUP BY measured_at
     ${require ? `HAVING \`${requireAlias(metrics, require)}\` IS NOT NULL` : ""}
     ORDER BY measured_at DESC LIMIT ?`,
    [...keys, userId, ...keys, limit],
  )
  return rows
}

function requireAlias(metrics: Record<string, string>, metric: string): string {
  const alias = Object.keys(metrics).find((a) => metrics[a] === metric)
  if (!alias) throw new Error(`${metric} is not in the pivot`)
  return alias
}

/**
 * Delete a whole measuring session: every listed metric sharing the
 * `measured_at` of the row identified by `entryId`. This is how a body-fat log
 * entry is removed — it was one row before the merge, so removing one id has to
 * remove the circumferences filed with it.
 */
export async function deleteMetricGroup(
  userId: number,
  entryId: number,
  metrics: readonly string[],
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM measurements
     WHERE user_id = ? AND metric IN (${metrics.map(() => "?").join(", ")})
       AND measured_at = (SELECT measured_at FROM (
             SELECT measured_at FROM measurements WHERE id = ? AND user_id = ?
           ) AS anchor)`,
    [userId, ...metrics, entryId, userId],
  )
  return result.affectedRows > 0
}

// ─── User-defined metrics ─────────────────────────────────────────────────────

export interface MetricDefinition extends RowDataPacket {
  id: number
  keyName: string
  label: string
  unit: string | null
  createdAt: Date | string
  updatedAt: Date | string
}

const DEFINITION_COLS = `id, key_name AS keyName, label, unit,
  created_at AS createdAt, updated_at AS updatedAt`

export async function createMetricDefinition(
  userId: number,
  keyName: string,
  label: string,
  unit?: string | null,
): Promise<MetricDefinition> {
  if (!keyName || !label)
    throw new ValidationError("keyName and label are required")
  requireMetricKeyShape(keyName)
  if (BUILT_IN_METRICS.includes(keyName))
    throw new ValidationError(`${keyName} is a built-in metric`)

  // uq_md_user_key: a duplicate key is a conflict, not a 500.
  let result: ResultSetHeader
  try {
    ;[result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO metric_definitions (user_id, key_name, label, unit) VALUES (?, ?, ?, ?)`,
      [userId, keyName, label, unit ?? null],
    )
  } catch (err) {
    if ((err as { errno?: number }).errno === 1062)
      throw new ConflictError(`Metric ${keyName} already exists`)
    throw err
  }
  const [rows] = await pool.execute<MetricDefinition[]>(
    `SELECT ${DEFINITION_COLS} FROM metric_definitions WHERE id = ?`,
    [result.insertId],
  )
  return rows[0]
}

export async function getMetricDefinitions(
  userId: number,
): Promise<MetricDefinition[]> {
  const [rows] = await pool.execute<MetricDefinition[]>(
    `SELECT ${DEFINITION_COLS} FROM metric_definitions
     WHERE user_id = ? ORDER BY created_at ASC`,
    [userId],
  )
  return rows
}

/**
 * Reject a metric key the caller has not defined. Built-ins are always allowed;
 * anything else needs a metric_definitions row, which is what keeps
 * `measurements.metric` from becoming a free-text dumping ground.
 */
export async function requireKnownMetric(
  userId: number,
  metric: string,
): Promise<void> {
  if (BUILT_IN_METRICS.includes(metric)) return
  requireMetricKeyShape(metric)
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT 1 FROM metric_definitions WHERE user_id = ? AND key_name = ?`,
    [userId, metric],
  )
  if (!rows[0]) throw new ValidationError(`Unknown metric: ${metric}`)
}
