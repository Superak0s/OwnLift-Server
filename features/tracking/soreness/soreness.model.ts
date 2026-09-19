// Muscle soreness (DOMS): one episode per row in `soreness`, with the
// check-in trail in `soreness_follow_up`.
//
// This used to be two features writing two tables — `muscle_soreness` for the
// plain "how sore am I today" log and `active_soreness` for episodes with
// follow-ups — which disagreed about the intensity range (1-10 vs 0-10) and
// about the note column's name. One table, one range (0-10), one `note`.

import { pool, formatDateForMySQL } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { PoolConnection } from "mysql2/promise"
import { ValidationError, NotFoundError } from "@/middleware/errorHandler.js"

export type FollowUpStatus = "still_sore" | "better" | "recovered"
export type SorenessStatus = "active" | "recovering" | "recovered"

export interface SorenessFollowUp {
  id: number
  sorenessId: number
  intensity: number
  status: FollowUpStatus
  note: string | null
  createdAt: string
}

export interface SorenessEntry {
  id: number
  muscleGroup: string
  intensity: number
  note: string | null
  loggedAt: string
  status: SorenessStatus
  recoveredAt: string | null
  createdAt: string
  updatedAt: string
  followUps: SorenessFollowUp[]
}

export interface SorenessStats {
  totalActiveSoreness: number
  totalRecoveryEpisodes: number
  averageRecoveryDays: number
  mostSoreMuscle: string | null
  heatmapData: Record<string, number>
  severityTrend: Array<{ date: string; averageIntensity: number }>
}

// Aliased to camelCase in SQL, so a row is already the wire shape bar followUps.
type SorenessRow = RowDataPacket & Omit<SorenessEntry, "followUps">
type FollowUpRow = RowDataPacket & SorenessFollowUp

const SORENESS_COLS = `id, muscle_group AS muscleGroup, intensity, note,
       logged_at AS loggedAt, status, recovered_at AS recoveredAt,
       created_at AS createdAt, updated_at AS updatedAt`

const FOLLOW_UP_COLS = `id, soreness_id AS sorenessId, intensity, status, note,
       created_at AS createdAt`

// Known, curated muscle groups. These get first-class treatment in the UI
// (grouped picker, consistent labels) but are not the only thing a user may
// log — see requireMuscleGroup below.
const VALID_MUSCLES = [
  "chest",
  "back",
  "legs",
  "quads",
  "hamstrings",
  "glutes",
  "arms",
  "biceps",
  "triceps",
  "forearms",
  "shoulders",
  "delts",
  "abs",
  "core",
  "calves",
  "lower_back",
  "neck",
  "traps",
] as const
type MuscleGroup = (typeof VALID_MUSCLES)[number]

// Anything else is allowed as a free-form body part as long as it is a
// reasonable, safe string. Not a security boundary (every insert is
// parameterized) — just hygiene, so we don't store essays or control
// characters typed by mistake.
const MAX_CUSTOM_MUSCLE_LENGTH = 50
// Letters (incl. accented), numbers, spaces, and the punctuation people
// actually use for body parts: "IT band", "Achilles tendon", "QL (lower back)".
const CUSTOM_MUSCLE_PATTERN = /^[\p{L}\p{N} '\-.()/]+$/u

const FOLLOW_UP_STATUSES: FollowUpStatus[] = [
  "still_sore",
  "better",
  "recovered",
]

function requireMuscleGroup(value: unknown): string {
  const muscle = String(value ?? "").trim()
  const ok =
    VALID_MUSCLES.includes(muscle as MuscleGroup) ||
    (muscle.length > 0 &&
      muscle.length <= MAX_CUSTOM_MUSCLE_LENGTH &&
      CUSTOM_MUSCLE_PATTERN.test(muscle))
  if (!ok) {
    throw new ValidationError(
      `Invalid muscle group. Use one of: ${VALID_MUSCLES.join(", ")} — or a custom ` +
        `name up to ${MAX_CUSTOM_MUSCLE_LENGTH} characters using letters, numbers, ` +
        `spaces, or the punctuation - ' . ( ) /`,
    )
  }
  return muscle
}

/** Matches ck_sor_intensity, so a bad value fails here rather than in MySQL. */
function requireIntensity(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 10)
    throw new ValidationError("Soreness intensity must be an integer from 0-10")
  return value as number
}

function requireFollowUpStatus(value: unknown): FollowUpStatus {
  if (!FOLLOW_UP_STATUSES.includes(value as FollowUpStatus))
    throw new ValidationError(
      `Invalid status. Must be one of: ${FOLLOW_UP_STATUSES.join(", ")}`,
    )
  return value as FollowUpStatus
}

/** A follow-up's reported status maps onto the episode's own status. */
function sorenessStatusFor(status: FollowUpStatus): SorenessStatus {
  if (status === "recovered") return "recovered"
  return status === "better" ? "recovering" : "active"
}

export async function logSoreness(
  userId: number,
  muscleGroup: string,
  intensity: number,
  loggedAt?: string | null,
  note?: string | null,
): Promise<SorenessEntry> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO soreness (user_id, muscle_group, intensity, note, logged_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      userId,
      requireMuscleGroup(muscleGroup),
      requireIntensity(intensity),
      note ?? null,
      formatDateForMySQL(loggedAt ? loggedAt : new Date()),
    ],
  )
  return getSorenessById(userId, result.insertId)
}

export async function getSorenessById(
  userId: number,
  sorenessId: number,
): Promise<SorenessEntry> {
  const [entry] = await listSoreness("user_id = ? AND id = ?", [
    userId,
    sorenessId,
  ])
  if (!entry) throw new NotFoundError("Soreness entry")
  return entry
}

export async function getSorenessHistory(
  userId: number,
  limit = 100,
): Promise<SorenessEntry[]> {
  return listSoreness("user_id = ?", [userId], "logged_at DESC", limit)
}

export async function getActiveSoreness(
  userId: number,
): Promise<SorenessEntry[]> {
  return listSoreness(
    "user_id = ? AND status IN ('active', 'recovering')",
    [userId],
    "updated_at DESC",
  )
}

export async function getHistoryByMuscle(
  userId: number,
  muscle: string,
  limit = 100,
): Promise<SorenessEntry[]> {
  return listSoreness(
    "user_id = ? AND muscle_group = ?",
    [userId, muscle],
    "logged_at DESC",
    limit,
  )
}

export async function addFollowUp(
  userId: number,
  sorenessId: number,
  intensity: number,
  status: FollowUpStatus,
  note?: string | null,
): Promise<SorenessEntry> {
  // Ownership guard: throws NotFoundError unless the episode is the caller's.
  await getSorenessById(userId, sorenessId)
  const [entry] = await applyFollowUps(userId, [
    { sorenessId, intensity, status, note },
  ])
  return entry!
}

/**
 * Apply many follow-ups in one go. Deliberately not a loop over addFollowUp:
 * that opened a connection, a transaction and two ownership reads per item, so
 * a 50-item batch cost ~450 round trips across 50 transactions. Here it is one
 * ownership check, one transaction, one INSERT, and one read back.
 *
 * Ids the caller doesn't own are skipped and reported back in `skipped`. A real
 * DB failure rolls the whole batch back rather than leaving it half-applied.
 */
export async function batchFollowUp(
  userId: number,
  updates: Array<{
    sorenessId: number
    intensity: number
    status: FollowUpStatus
    note?: string | null
  }>,
): Promise<{ entries: SorenessEntry[]; skipped: number[] }> {
  if (updates.length > 50)
    throw new ValidationError("Too many updates in a single batch")
  if (!updates.length) return { entries: [], skipped: [] }

  const [owned] = await pool.execute<(RowDataPacket & { id: number })[]>(
    `SELECT id FROM soreness
     WHERE user_id = ? AND id IN (${updates.map(() => "?").join(", ")})`,
    [userId, ...updates.map((u) => u.sorenessId)],
  )
  const ownedIds = new Set(owned.map((r) => r.id))
  // Which ids were dropped, not just how many came back: a client that sent 5
  // and got 4 otherwise has no way to tell which episode it failed to update.
  return {
    entries: await applyFollowUps(
      userId,
      updates.filter((u) => ownedIds.has(u.sorenessId)),
    ),
    skipped: updates
      .map((u) => u.sorenessId)
      .filter((id) => !ownedIds.has(id)),
  }
}

async function applyFollowUps(
  userId: number,
  updates: Array<{
    sorenessId: number
    intensity: number
    status: FollowUpStatus
    note?: string | null
  }>,
): Promise<SorenessEntry[]> {
  // Validate everything before opening a transaction — a bad item in the
  // middle of a batch should cost nothing.
  // note: undefined means "leave the episode note alone" — null is an explicit
  // clear, and the two are different on the wire.
  const applicable = updates.map((u) => ({
    sorenessId: u.sorenessId,
    intensity: requireIntensity(u.intensity),
    status: requireFollowUpStatus(u.status),
    note: u.note,
  }))
  if (!applicable.length) return []

  const now = formatDateForMySQL(new Date())
  const connection: PoolConnection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    for (const u of applicable) {
      const sets = ["intensity = ?", "status = ?", "recovered_at = ?"]
      const params: (string | number | null)[] = [
        u.intensity,
        sorenessStatusFor(u.status),
        u.status === "recovered" ? now : null,
      ]
      if (u.note !== undefined) {
        sets.push("note = ?")
        params.push(u.note)
      }
      params.push(u.sorenessId, userId)
      await connection.execute(
        `UPDATE soreness SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
        params,
      )
    }

    await connection.execute(
      `INSERT INTO soreness_follow_up (soreness_id, intensity, status, note)
       VALUES ${applicable.map(() => "(?, ?, ?, ?)").join(", ")}`,
      applicable.flatMap((u) => [u.sorenessId, u.intensity, u.status, u.note ?? null]),
    )

    await connection.commit()
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }

  return listSoreness(
    `user_id = ? AND id IN (${applicable.map(() => "?").join(", ")})`,
    [userId, ...applicable.map((u) => u.sorenessId)],
    "updated_at DESC",
  )
}

export async function deleteSorenessEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  // Follow-ups go with it: fk_sfu_soreness is ON DELETE CASCADE.
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM soreness WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  )
  return result.affectedRows > 0
}

export async function getSorenessStats(
  userId: number,
  days = 30,
): Promise<SorenessStats> {
  // Six independent aggregates over one table. The heatmap and trend halves
  // lean on idx_sor_user_logged.
  const [
    [activeRows],
    [recoveredRows],
    [avgRows],
    [mostSoreRows],
    [heatmapRows],
    [trendRows],
  ] = await Promise.all([
    pool.execute<(RowDataPacket & { count: number })[]>(
      `SELECT COUNT(*) AS count FROM soreness
       WHERE user_id = ? AND status IN ('active', 'recovering')`,
      [userId],
    ),
    pool.execute<(RowDataPacket & { count: number })[]>(
      `SELECT COUNT(*) AS count FROM soreness
       WHERE user_id = ? AND status = 'recovered'`,
      [userId],
    ),
    pool.execute<(RowDataPacket & { avgDays: number | null })[]>(
      `SELECT AVG(DATEDIFF(recovered_at, logged_at)) AS avgDays FROM soreness
       WHERE user_id = ? AND status = 'recovered' AND recovered_at IS NOT NULL`,
      [userId],
    ),
    pool.execute<(RowDataPacket & { muscleGroup: string })[]>(
      `SELECT muscle_group AS muscleGroup FROM soreness
       WHERE user_id = ? AND status IN ('active', 'recovering')
       ORDER BY intensity DESC LIMIT 1`,
      [userId],
    ),
    pool.execute<(RowDataPacket & { muscleGroup: string; freq: number })[]>(
      `SELECT muscle_group AS muscleGroup, COUNT(*) AS freq FROM soreness
       WHERE user_id = ? AND logged_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY muscle_group`,
      [userId, days],
    ),
    pool.execute<(RowDataPacket & { date: string; avgIntensity: number })[]>(
      `SELECT DATE(logged_at) AS date, AVG(intensity) AS avgIntensity
       FROM soreness
       WHERE user_id = ? AND logged_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY DATE(logged_at)
       ORDER BY date ASC`,
      [userId, days],
    ),
  ])

  const heatmapData: Record<string, number> = {}
  for (const row of heatmapRows) heatmapData[row.muscleGroup] = row.freq

  return {
    totalActiveSoreness: activeRows[0]?.count ?? 0,
    totalRecoveryEpisodes: recoveredRows[0]?.count ?? 0,
    averageRecoveryDays: Number((avgRows[0]?.avgDays ?? 0).toFixed(1)),
    mostSoreMuscle: mostSoreRows[0]?.muscleGroup ?? null,
    heatmapData,
    severityTrend: trendRows.map((r) => ({
      date: r.date,
      averageIntensity: Number(Number(r.avgIntensity).toFixed(1)),
    })),
  }
}

/**
 * Soreness rows matching `where`, each with its follow-ups attached. The
 * follow-ups come back in one batched query rather than one per row.
 */
async function listSoreness(
  where: string,
  params: (string | number)[],
  orderBy = "logged_at DESC",
  limit?: number,
): Promise<SorenessEntry[]> {
  const [rows] = await pool.execute<SorenessRow[]>(
    `SELECT ${SORENESS_COLS} FROM soreness
     WHERE ${where} ORDER BY ${orderBy}${limit ? " LIMIT ?" : ""}`,
    limit ? [...params, limit] : params,
  )
  if (!rows.length) return []

  const [followUps] = await pool.execute<FollowUpRow[]>(
    `SELECT ${FOLLOW_UP_COLS} FROM soreness_follow_up
     WHERE soreness_id IN (${rows.map(() => "?").join(", ")})
     ORDER BY created_at ASC, id ASC`,
    rows.map((r) => r.id),
  )
  const bySoreness = new Map<number, SorenessFollowUp[]>()
  for (const f of followUps) {
    const list = bySoreness.get(f.sorenessId)
    if (list) list.push(f)
    else bySoreness.set(f.sorenessId, [f])
  }
  return rows.map((r) => ({ ...r, followUps: bySoreness.get(r.id) ?? [] }))
}
