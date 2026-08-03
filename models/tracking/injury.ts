// src/models/tracking/injury.ts
// Injury tracking model

import { pool } from "../../config/database.js";
import { query as dbQuery } from "../../config/database.js";
import type { RowDataPacket } from "mysql2";
import type { InsertResult } from "../../types/index.js";
import { formatDateForMySQL } from "../utils/dateHelpers.js";
import { ValidationError, NotFoundError } from "../../middleware/errorHandler.js";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export type InjuryType =
  | "strain"
  | "sprain"
  | "tendonitis"
  | "fracture"
  | "dislocation"
  | "tear"
  | "overuse"
  | "surgery"
  | "other";

export type InjuryStatus = "active" | "recovering" | "recovered";

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

export interface InjuryRecord {
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

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface InjuryRow extends RowDataPacket {
  id: number;
  muscle_group: string;
  injury_type: string;
  pain_level: number;
  start_date: Date;
  recovery_date: Date | null;
  notes: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

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

  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
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

  const id = (result as unknown as InsertResult).insertId;
  return getInjuryById(userId, id);
}

export async function getInjuryById(
  userId: number,
  injuryId: number,
): Promise<InjuryRecord> {
  const [rows] = await dbQuery<InjuryRow[]>(
    `SELECT * FROM injuries WHERE id = ? AND user_id = ?`,
    [injuryId, userId],
  );
  if (!rows[0]) throw new NotFoundError("Injury");
  return formatInjury(rows[0]);
}

export async function updateInjury(
  userId: number,
  injuryId: number,
  updates: {
    status?: InjuryStatus;
    recoveryDate?: string;
    notes?: string;
    painLevel?: number;
  },
): Promise<InjuryRecord> {
  // Verify injury exists
  await getInjuryById(userId, injuryId);

  const setClauses: string[] = [];
  const params: (string | number | null)[] = [];

  if (updates.status !== undefined) {
    if (!["active", "recovering", "recovered"].includes(updates.status)) {
      throw new ValidationError("Status must be 'active', 'recovering', or 'recovered'");
    }
    setClauses.push("status = ?");
    params.push(updates.status);
  }

  if (updates.recoveryDate !== undefined) {
    setClauses.push("recovery_date = ?");
    params.push(
      updates.recoveryDate ? formatDateForMySQL(updates.recoveryDate) : null,
    );
    if (!updates.status && updates.recoveryDate) {
      setClauses.push("status = ?");
      params.push("recovered");
    }
  }

  if (updates.notes !== undefined) {
    setClauses.push("notes = ?");
    params.push(updates.notes ?? null);
  }

  if (updates.painLevel !== undefined) {
    if (
      !Number.isInteger(updates.painLevel) ||
      updates.painLevel < 0 ||
      updates.painLevel > 10
    ) {
      throw new ValidationError("Pain level must be an integer from 0-10");
    }
    setClauses.push("pain_level = ?");
    params.push(updates.painLevel);
  }

  if (setClauses.length === 0) {
    throw new ValidationError("No valid update fields provided");
  }

  setClauses.push("updated_at = ?");
  params.push(formatDateForMySQL(new Date()));
  params.push(injuryId);
  params.push(userId);

  await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `UPDATE injuries SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`,
    params,
  );

  return getInjuryById(userId, injuryId);
}

export async function getAllInjuries(
  userId: number,
): Promise<InjuryRecord[]> {
  const [rows] = await dbQuery<InjuryRow[]>(
    `SELECT * FROM injuries WHERE user_id = ? ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(formatInjury);
}

export async function getInjuriesByMuscle(
  userId: number,
  muscle: string,
): Promise<InjuryRecord[]> {
  const [rows] = await dbQuery<InjuryRow[]>(
    `SELECT * FROM injuries WHERE user_id = ? AND muscle_group = ? ORDER BY created_at DESC`,
    [userId, muscle],
  );
  return rows.map(formatInjury);
}

export async function getActiveInjuries(
  userId: number,
): Promise<InjuryRecord[]> {
  const [rows] = await dbQuery<InjuryRow[]>(
    `SELECT * FROM injuries WHERE user_id = ? AND status IN ('active', 'recovering') ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(formatInjury);
}

export async function deleteInjury(
  userId: number,
  injuryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`DELETE FROM injuries WHERE id = ? AND user_id = ?`, [injuryId, userId]);
  return (result as unknown as InsertResult).affectedRows > 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatInjury(row: InjuryRow): InjuryRecord {
  return {
    id: row.id,
    muscleGroup: row.muscle_group,
    injuryType: row.injury_type as InjuryType,
    painLevel: row.pain_level,
    startDate: row.start_date,
    recoveryDate: row.recovery_date,
    notes: row.notes,
    status: row.status as InjuryStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
