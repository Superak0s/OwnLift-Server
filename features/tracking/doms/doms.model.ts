// DOMS (Delayed Onset Muscle Soreness) active tracking with follow-ups

import { pool, formatDateForMySQL } from "@/config/database.js";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { logger } from "@/utils/logger.js";
import { ValidationError, NotFoundError } from "@/middleware/errorHandler.js";

interface SorenessFollowUp {
  id: number;
  sorenessId: number;
  intensity: number;
  status: "still_sore" | "better" | "recovered";
  notes: string | null;
  updatedAt: Date;
}

interface ActiveSoreness {
  id: number;
  muscleGroup: string;
  intensity: number;
  notes: string | null;
  loggedAt: Date;
  updatedAt: Date;
  recoveredAt: Date | null;
  status: "active" | "recovering" | "recovered";
  followUps: SorenessFollowUp[];
}

interface DOMSStats {
  totalActiveSoreness: number;
  totalRecoveryEpisodes: number;
  averageRecoveryDays: number;
  mostSoreMuscle: string | null;
  heatmapData: Record<string, number>;
  severityTrend: Array<{ date: string; averageIntensity: number }>;
}

interface ActiveSorenessRow extends RowDataPacket {
  id: number;
  muscle_group: string;
  intensity: number;
  notes: string | null;
  logged_at: Date;
  updated_at: Date;
  recovered_at: Date | null;
  status: string;
}

interface FollowUpRow extends RowDataPacket {
  id: number;
  soreness_id: number;
  intensity: number;
  status: string;
  notes: string | null;
  updated_at: Date;
}

export async function logSoreness(
  userId: number,
  muscleGroup: string,
  intensity: number,
  notes?: string | null,
  loggedAt?: string | null,
): Promise<ActiveSoreness> {
  if (!Number.isInteger(intensity) || intensity < 0 || intensity > 10) {
    throw new ValidationError("Intensity must be an integer from 0-10");
  }

  const [existing] = await pool.execute<ActiveSorenessRow[]>(
    `SELECT id FROM active_soreness WHERE user_id = ? AND muscle_group = ? AND status IN ('active', 'recovering')`,
    [userId, muscleGroup],
  );

  if (existing[0]) {
    throw new ValidationError(
      `Active soreness already exists for ${muscleGroup}. Update it or mark it recovered first.`,
    );
  }

  const ts = formatDateForMySQL(loggedAt ?? new Date());
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO active_soreness (user_id, muscle_group, intensity, notes, status, logged_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [userId, muscleGroup, intensity, notes ?? null, ts, ts],
  );

  const id = result.insertId;
  return getSorenessById(userId, id);
}

async function getSorenessById(
  userId: number,
  sorenessId: number,
): Promise<ActiveSoreness> {
  const [rows] = await pool.execute<ActiveSorenessRow[]>(
    `SELECT * FROM active_soreness WHERE id = ? AND user_id = ?`,
    [sorenessId, userId],
  );
  if (!rows[0]) throw new NotFoundError("Active soreness");

  const followUps = await getFollowUpsForSoreness(userId, sorenessId);
  return formatActiveSoreness(rows[0], followUps);
}

export async function getActiveSoreness(
  userId: number,
): Promise<ActiveSoreness[]> {
  const [rows] = await pool.execute<ActiveSorenessRow[]>(
    `SELECT * FROM active_soreness WHERE user_id = ? AND status IN ('active', 'recovering')
     ORDER BY updated_at DESC`,
    [userId],
  );

  const results: ActiveSoreness[] = [];
  for (const row of rows) {
    const followUps = await getFollowUpsForSoreness(userId, row.id);
    results.push(formatActiveSoreness(row, followUps));
  }
  return results;
}

export async function updateSorenessWithFollowUp(
  userId: number,
  sorenessId: number,
  intensity: number,
  status: "still_sore" | "better" | "recovered",
  notes?: string | null,
): Promise<ActiveSoreness> {
  // Ownership guard: throws NotFoundError unless this soreness row is the
  // caller's. The row itself is not needed here.
  await getSorenessById(userId, sorenessId);

  if (!Number.isInteger(intensity) || intensity < 0 || intensity > 10) {
    throw new ValidationError("Intensity must be an integer from 0-10");
  }

  const now = formatDateForMySQL(new Date());

  const newSorenessStatus: "active" | "recovering" | "recovered" =
    status === "recovered"
      ? "recovered"
      : status === "better"
        ? "recovering"
        : "active";

  const connection: PoolConnection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute<ResultSetHeader>(
      `UPDATE active_soreness
       SET intensity = ?, status = ?, updated_at = ?, recovered_at = COALESCE(recovered_at, ?), notes = COALESCE(?, notes)
       WHERE id = ? AND user_id = ?`,
      [
        intensity,
        newSorenessStatus,
        now,
        status === "recovered" ? now : null,
        notes ?? null,
        sorenessId,
        userId,
      ],
    );

    await connection.execute<ResultSetHeader>(
      `INSERT INTO soreness_follow_up (soreness_id, intensity, status, notes, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [sorenessId, intensity, status, notes ?? null, now],
    );

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  return getSorenessById(userId, sorenessId);
}

export async function batchFollowUp(
  userId: number,
  updates: Array<{
    sorenessId: number;
    intensity: number;
    status: "still_sore" | "better" | "recovered";
    notes?: string;
  }>,
): Promise<ActiveSoreness[]> {
  if (updates.length > 50)
    throw new ValidationError("Too many updates in a single batch");

  const results: ActiveSoreness[] = [];

  for (const update of updates) {
    try {
      const result = await updateSorenessWithFollowUp(
        userId,
        update.sorenessId,
        update.intensity,
        update.status,
        update.notes ?? null,
      );
      results.push(result);
    } catch (error) {
      logger.error(
        `Error updating soreness ${update.sorenessId}:`,
        error,
      );
    }
  }

  return results;
}

export async function getHistoryByMuscle(
  userId: number,
  muscle: string,
): Promise<ActiveSoreness[]> {
  const [rows] = await pool.execute<ActiveSorenessRow[]>(
    `SELECT * FROM active_soreness WHERE user_id = ? AND muscle_group = ?
     ORDER BY logged_at DESC`,
    [userId, muscle],
  );

  const results: ActiveSoreness[] = [];
  for (const row of rows) {
    const followUps = await getFollowUpsForSoreness(userId, row.id);
    results.push(formatActiveSoreness(row, followUps));
  }
  return results;
}

export async function getDOMSStats(
  userId: number,
  days: number = 30,
): Promise<DOMSStats> {
  const [activeRows] = await pool.execute<(RowDataPacket & { count: number })[]>(
    `SELECT COUNT(*) AS count FROM active_soreness
     WHERE user_id = ? AND status IN ('active', 'recovering')`,
    [userId],
  );

  const [recoveredRows] = await pool.execute<(RowDataPacket & { count: number })[]>(
    `SELECT COUNT(*) AS count FROM active_soreness
     WHERE user_id = ? AND status = 'recovered'`,
    [userId],
  );

  const [avgRows] = await pool.execute<
    (RowDataPacket & { avg_days: number | null })[]
  >(
    `SELECT AVG(DATEDIFF(recovered_at, logged_at)) AS avg_days
     FROM active_soreness
     WHERE user_id = ? AND status = 'recovered' AND recovered_at IS NOT NULL`,
    [userId],
  );

  const [mostSoreRows] = await pool.execute<
    (RowDataPacket & { muscle_group: string })[]
  >(
    `SELECT muscle_group, intensity FROM active_soreness
     WHERE user_id = ? AND status IN ('active', 'recovering')
     ORDER BY intensity DESC LIMIT 1`,
    [userId],
  );

  const [heatmapRows] = await pool.execute<
    (RowDataPacket & { muscle_group: string; freq: number })[]
  >(
    `SELECT muscle_group AS muscle_group, COUNT(*) AS freq
     FROM active_soreness
     WHERE user_id = ? AND logged_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY muscle_group`,
    [userId, days],
  );

  const [trendRows] = await pool.execute<
    (RowDataPacket & { date: string; avg_intensity: number })[]
  >(
    `SELECT DATE(logged_at) AS date, AVG(intensity) AS avg_intensity
     FROM active_soreness
     WHERE user_id = ? AND logged_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY DATE(logged_at)
     ORDER BY date ASC`,
    [userId, days],
  );

  const heatmapData: Record<string, number> = {};
  for (const row of heatmapRows) {
    heatmapData[row.muscle_group] = row.freq;
  }

  return {
    totalActiveSoreness: activeRows[0]?.count ?? 0,
    totalRecoveryEpisodes: recoveredRows[0]?.count ?? 0,
    averageRecoveryDays: parseFloat(
      (avgRows[0]?.avg_days ?? 0).toFixed(1),
    ),
    mostSoreMuscle: mostSoreRows[0]?.muscle_group ?? null,
    heatmapData,
    severityTrend: trendRows.map((r) => ({
      date: r.date,
      averageIntensity: parseFloat(r.avg_intensity.toFixed(1)),
    })),
  };
}

async function getFollowUpsForSoreness(
  _userId: number,
  sorenessId: number,
): Promise<SorenessFollowUp[]> {
  const [rows] = await pool.execute<FollowUpRow[]>(
    `SELECT * FROM soreness_follow_up WHERE soreness_id = ? ORDER BY updated_at ASC`,
    [sorenessId],
  );
  return rows.map((r) => ({
    id: r.id,
    sorenessId: r.soreness_id,
    intensity: r.intensity,
    status: r.status as SorenessFollowUp["status"],
    notes: r.notes,
    updatedAt: r.updated_at,
  }));
}

function formatActiveSoreness(
  row: ActiveSorenessRow,
  followUps: SorenessFollowUp[],
): ActiveSoreness {
  return {
    id: row.id,
    muscleGroup: row.muscle_group,
    intensity: row.intensity,
    notes: row.notes,
    loggedAt: row.logged_at,
    updatedAt: row.updated_at,
    recoveredAt: row.recovered_at,
    status: row.status as ActiveSoreness["status"],
    followUps,
  };
}
