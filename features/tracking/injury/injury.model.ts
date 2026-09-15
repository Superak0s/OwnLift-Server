// Injury tracking model

import { pool, formatDateForMySQL } from "@/config/database.js";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { ValidationError, NotFoundError } from "@/middleware/errorHandler.js";

// ─── Interfaces ───────────────────────────────────────────────────────────────

type InjuryType =
  | "strain"
  | "sprain"
  | "tendonitis"
  | "fracture"
  | "dislocation"
  | "tear"
  | "overuse"
  | "surgery"
  | "other";

type InjuryStatus = "active" | "recovering" | "recovered";

const VALID_INJURY_TYPES: InjuryType[] = [
  "strain",
  "sprain",
  "tendonitis",
  "fracture",
  "dislocation",
  "tear",
  "overuse",
  "surgery",
  "other",
];

// Aliased to camelCase in SQL, so the query result is already the wire shape.
interface InjuryRecord extends RowDataPacket {
  id: number;
  muscleGroup: string;
  injuryType: InjuryType;
  painLevel: number;
  startDate: Date;
  recoveryDate: Date | null;
  notes: string | null;
  status: InjuryStatus;
  createdAt: Date;
  updatedAt: Date;
}

const INJURY_COLS = `id, muscle_group AS muscleGroup, injury_type AS injuryType,
       pain_level AS painLevel, start_date AS startDate,
       recovery_date AS recoveryDate, notes, status,
       created_at AS createdAt, updated_at AS updatedAt`;

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function logInjury(
  userId: number,
  muscleGroup: string,
  injuryType: InjuryType,
  painLevel: number,
  startDate: string,
  notes?: string | null,
): Promise<InjuryRecord> {
  if (!VALID_INJURY_TYPES.includes(injuryType)) {
    throw new ValidationError(
      `Invalid injury type. Must be one of: ${VALID_INJURY_TYPES.join(", ")}`,
    );
  }

  if (!Number.isInteger(painLevel) || painLevel < 0 || painLevel > 10) {
    throw new ValidationError("Pain level must be an integer from 0-10");
  }

  const startTs = formatDateForMySQL(startDate ? startDate : new Date());
  const now = formatDateForMySQL(new Date());

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO injuries (user_id, muscle_group, injury_type, pain_level, start_date, notes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      userId,
      muscleGroup,
      injuryType,
      painLevel,
      startTs,
      notes ?? null,
      now,
      now,
    ],
  );

  const id = result.insertId;
  return getInjuryById(userId, id);
}

async function getInjuryById(
  userId: number,
  injuryId: number,
): Promise<InjuryRecord> {
  const [rows] = await pool.execute<InjuryRecord[]>(
    `SELECT ${INJURY_COLS} FROM injuries WHERE id = ? AND user_id = ?`,
    [injuryId, userId],
  );
  if (!rows[0]) throw new NotFoundError("Injury");
  return rows[0];
}

export async function getAllInjuries(
  userId: number,
  limit = 100,
): Promise<InjuryRecord[]> {
  const [rows] = await pool.execute<InjuryRecord[]>(
    `SELECT ${INJURY_COLS} FROM injuries WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows;
}

export async function getInjuriesByMuscle(
  userId: number,
  muscle: string,
  limit = 100,
): Promise<InjuryRecord[]> {
  const [rows] = await pool.execute<InjuryRecord[]>(
    `SELECT ${INJURY_COLS} FROM injuries WHERE user_id = ? AND muscle_group = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, muscle, limit],
  );
  return rows;
}

export async function getActiveInjuries(
  userId: number,
  limit = 100,
): Promise<InjuryRecord[]> {
  const [rows] = await pool.execute<InjuryRecord[]>(
    `SELECT ${INJURY_COLS} FROM injuries WHERE user_id = ? AND status IN ('active', 'recovering') ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows;
}
