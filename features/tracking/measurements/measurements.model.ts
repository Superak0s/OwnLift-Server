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
      null,
      "METRIC_UNKNOWN",
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
 * Writing the same metric at the same instant twice overwrites rather than
 * duplicating (uq_m_user_metric_at). Two devices that were both offline for a
 * week replay the same days on reconnect, and the user has no way to tell which
 * of the resulting twin points is real — a re-sync has to be a no-op.
 *
 * Returns the lowest id in the session — the handle the delete endpoints use to
 * find the group again. It is read back rather than taken from insertId, which
 * an upsert only sets for rows it actually inserted.
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
  await pool.execute<ResultSetHeader>(
    `INSERT INTO measurements (user_id, metric, value, measured_at, note) VALUES
     ${samples.map(() => "(?, ?, ?, ?, ?)").join(", ")}
     ON DUPLICATE KEY UPDATE value = VALUES(value), note = VALUES(note)`,
    samples.flatMap((s) => [userId, s.metric, s.value, ts, note ?? null]),
  )

  const [rows] = await pool.execute<(RowDataPacket & { id: number })[]>(
    `SELECT MIN(id) AS id FROM measurements
     WHERE user_id = ? AND measured_at = ?
       AND metric IN (${samples.map(() => "?").join(", ")})`,
    [userId, ts, ...samples.map((s) => s.metric)],
  )
  return rows[0].id
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
      throw new ConflictError(
        `Metric ${keyName} already exists`,
        "DUPLICATE_METRIC",
      )
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
export async function requireKnownMetrics(
  userId: number,
  metrics: readonly string[],
): Promise<void> {
  const custom = metrics.filter((m) => !BUILT_IN_METRICS.includes(m))
  if (!custom.length) return
  custom.forEach(requireMetricKeyShape)

  const [rows] = await pool.execute<(RowDataPacket & { key_name: string })[]>(
    `SELECT key_name FROM metric_definitions
     WHERE user_id = ? AND key_name IN (${custom.map(() => "?").join(", ")})`,
    [userId, ...custom],
  )
  const defined = new Set(rows.map((r) => r.key_name))
  const unknown = custom.find((m) => !defined.has(m))
  if (unknown)
    throw new ValidationError(`Unknown metric: ${unknown}`, null, "METRIC_UNKNOWN")
}

export const requireKnownMetric = (
  userId: number,
  metric: string,
): Promise<void> => requireKnownMetrics(userId, [metric])
