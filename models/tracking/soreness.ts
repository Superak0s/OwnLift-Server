// src/models/tracking/soreness.ts
// Track muscle soreness (DOMS) by body part

import { pool } from "../../config/database.js";
import { query as dbQuery } from "../../config/database.js";
import type { RowDataPacket } from "mysql2";
import type { InsertResult } from "../../types/index.js";
import { formatDateForMySQL } from "../utils/dateHelpers.js";
import { ValidationError } from "../../middleware/errorHandler.js";

export interface SorenessEntry {
  id: number;
  muscleGroup: string;
  intensity: number; // 1-10 scale
  loggedAt: Date;
  note?: string | null;
  createdAt: Date;
}

export interface SorenessMap {
  date: Date;
  entries: Record<string, number>; // muscle_group -> intensity
}

export interface SorenessStats {
  mostSoreMuscle: { muscle: string; intensity: number } | null;
  averageIntensity: number;
  affectedMuscles: number;
  lastEntry: SorenessEntry | null;
}

// Known, curated muscle groups. These get first-class treatment in the UI
// (grouped picker, consistent labels) but are no longer the *only* thing
// a user is allowed to log — see isValidMuscleGroup below.
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
] as const;
export type MuscleGroup = (typeof VALID_MUSCLES)[number];

// ─── Custom body part validation ───────────────────────────────────────────
// Anything not in VALID_MUSCLES is allowed as a free-form "custom" body
// part, as long as it's a reasonable, safe string. This isn't a security
// boundary (the insert is parameterized either way) — it's just data
// hygiene so we don't store empty strings, novel-length essays, or stray
// control characters typed by mistake.
const MAX_CUSTOM_MUSCLE_LENGTH = 50;
// Letters (incl. accented), numbers, spaces, and common punctuation people
// actually use for body parts: "IT band", "Achilles tendon", "QL (lower back)".
const CUSTOM_MUSCLE_PATTERN = /^[\p{L}\p{N} '\-.()/]+$/u;

function isValidMuscleGroup(value: string): boolean {
  if (VALID_MUSCLES.includes(value as MuscleGroup)) return true;
  return (
    value.length > 0 &&
    value.length <= MAX_CUSTOM_MUSCLE_LENGTH &&
    CUSTOM_MUSCLE_PATTERN.test(value)
  );
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface SorenessRow extends RowDataPacket {
  id: number;
  muscle_group: string;
  intensity: number;
  logged_at: Date;
  note: string | null;
  created_at: Date;
}

interface MaxRow extends RowDataPacket {
  muscle_group: string;
  intensity: number;
}

interface AvgRow extends RowDataPacket {
  avg_intensity: number | null;
  unique_muscles: number;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function logSoreness(
  userId: number,
  muscleGroup: string,
  intensity: number,
  loggedAt?: string | null,
  note?: string | null,
): Promise<number> {
  const trimmedMuscle = (muscleGroup ?? "").trim();

  if (!isValidMuscleGroup(trimmedMuscle)) {
    throw new ValidationError(
      `Invalid muscle group. Use one of: ${VALID_MUSCLES.join(", ")} — or a custom ` +
        `name up to ${MAX_CUSTOM_MUSCLE_LENGTH} characters using letters, numbers, ` +
        `spaces, or the punctuation - ' . ( ) /`,
    );
  }

  if (!Number.isInteger(intensity) || intensity < 1 || intensity > 10) {
    throw new ValidationError(
      "Soreness intensity must be an integer from 1-10",
    );
  }

  const ts = formatDateForMySQL(loggedAt ? loggedAt : new Date());
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `INSERT INTO muscle_soreness (user_id, muscle_group, intensity, logged_at, note)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, trimmedMuscle, intensity, ts, note ?? null],
  );
  return (result as unknown as InsertResult).insertId;
}

export async function getSorenessHistory(
  userId: number,
  limit = 100,
): Promise<SorenessEntry[]> {
  const [rows] = await dbQuery<SorenessRow[]>(
    `SELECT id, muscle_group, intensity, logged_at, note, created_at
     FROM muscle_soreness WHERE user_id = ? ORDER BY logged_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows.map(formatEntry);
}

export async function getSorenessForDate(
  userId: number,
  date: string,
): Promise<SorenessEntry[]> {
  const [rows] = await dbQuery<SorenessRow[]>(
    `SELECT id, muscle_group, intensity, logged_at, note, created_at
     FROM muscle_soreness WHERE user_id = ? AND DATE(logged_at) = ? ORDER BY logged_at DESC`,
    [userId, date],
  );
  return rows.map(formatEntry);
}

export async function getSorenessMap(
  userId: number,
  date?: string,
): Promise<SorenessMap> {
  const entries = date
    ? await getSorenessForDate(userId, date)
    : await getLatestSorenessEntries(userId);

  const map: Record<string, number> = {};
  for (const entry of entries) {
    map[entry.muscleGroup] = entry.intensity;
  }

  return {
    date: new Date(date || new Date().toISOString().split("T")[0]),
    entries: map,
  };
}

export async function getSorenessStats(
  userId: number,
  days = 7,
): Promise<SorenessStats> {
  // Most sore muscle in the period
  const [maxRows] = await dbQuery<MaxRow[]>(
    `SELECT muscle_group, intensity FROM muscle_soreness
     WHERE user_id = ? AND logged_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     ORDER BY intensity DESC LIMIT 1`,
    [userId, days],
  );

  // Average intensity and affected muscles
  const [avgRows] = await dbQuery<AvgRow[]>(
    `SELECT AVG(intensity) AS avg_intensity, COUNT(DISTINCT muscle_group) AS unique_muscles
     FROM muscle_soreness WHERE user_id = ? AND logged_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [userId, days],
  );
  const avgStats = avgRows[0];

  const lastEntry = await getLastSorenessEntry(userId);

  return {
    mostSoreMuscle: maxRows[0]
      ? { muscle: maxRows[0].muscle_group, intensity: maxRows[0].intensity }
      : null,
    averageIntensity: parseFloat((avgStats.avg_intensity || 0).toFixed(1)),
    affectedMuscles: avgStats.unique_muscles,
    lastEntry,
  };
}

export async function deleteSorenessEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`DELETE FROM muscle_soreness WHERE id = ? AND user_id = ?`, [
    entryId,
    userId,
  ]);
  return (result as unknown as InsertResult).affectedRows > 0;
}

export function getValidMuscleGroups(): typeof VALID_MUSCLES {
  return VALID_MUSCLES;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getLatestSorenessEntries(
  userId: number,
): Promise<SorenessEntry[]> {
  // Get the most recent entry per muscle group
  const [rows] = await dbQuery<SorenessRow[]>(
    `SELECT id, muscle_group, intensity, logged_at, note, created_at FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY muscle_group ORDER BY logged_at DESC) as rn
       FROM muscle_soreness WHERE user_id = ?
     ) ranked WHERE rn = 1`,
    [userId],
  );
  return rows.map(formatEntry);
}

async function getLastSorenessEntry(
  userId: number,
): Promise<SorenessEntry | null> {
  const [rows] = await dbQuery<SorenessRow[]>(
    `SELECT id, muscle_group, intensity, logged_at, note, created_at
     FROM muscle_soreness WHERE user_id = ? ORDER BY logged_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0] ? formatEntry(rows[0]) : null;
}

function formatEntry(row: SorenessRow): SorenessEntry {
  return {
    id: row.id,
    muscleGroup: row.muscle_group,
    intensity: row.intensity,
    loggedAt: row.logged_at,
    note: row.note,
    createdAt: row.created_at,
  };
}
