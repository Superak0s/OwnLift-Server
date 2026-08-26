// Track muscle soreness (DOMS) by body part.
//
// Distinct from features/tracking/doms/: this is the plain intensity log the
// app's soreness service reads (log, history, delete), while doms/ tracks
// active soreness with follow-ups and recovery status. The app uses both.

import { pool, formatDateForMySQL } from "@/config/database.js";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { ValidationError } from "@/middleware/errorHandler.js";

// Aliased to camelCase in SQL, so the query result is already the wire shape.
interface SorenessEntry extends RowDataPacket {
  id: number;
  muscleGroup: string;
  intensity: number; // 1-10 scale
  loggedAt: Date;
  note: string | null;
  createdAt: Date;
}

const SORENESS_COLS = `id, muscle_group AS muscleGroup, intensity,
       logged_at AS loggedAt, note, created_at AS createdAt`;

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
type MuscleGroup = (typeof VALID_MUSCLES)[number];

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
    throw new ValidationError("Soreness intensity must be an integer from 1-10");
  }

  const ts = formatDateForMySQL(loggedAt ? loggedAt : new Date());
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO muscle_soreness (user_id, muscle_group, intensity, logged_at, note)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, trimmedMuscle, intensity, ts, note ?? null],
  );
  return result.insertId;
}

export async function getSorenessHistory(
  userId: number,
  limit = 100,
): Promise<SorenessEntry[]> {
  const [rows] = await pool.execute<SorenessEntry[]>(
    `SELECT ${SORENESS_COLS}
     FROM muscle_soreness WHERE user_id = ? ORDER BY logged_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows;
}

export async function deleteSorenessEntry(
  userId: number,
  entryId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM muscle_soreness WHERE id = ? AND user_id = ?`,
    [entryId, userId],
  );
  return result.affectedRows > 0;
}
