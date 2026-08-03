// src/models/tracking/personalNotes.ts
// Personal Muscle Notes model

import { pool } from "../../config/database.js";
import { query as dbQuery } from "../../config/database.js";
import type { RowDataPacket } from "mysql2";
import type { InsertResult } from "../../types/index.js";
import { formatDateForMySQL } from "../utils/dateHelpers.js";
import { ValidationError, NotFoundError } from "../../middleware/errorHandler.js";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface PersonalMuscleNote {
  id: number;
  muscleGroup: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface PersonalNoteRow extends RowDataPacket {
  id: number;
  muscle_group: string;
  content: string;
  created_at: Date;
  updated_at: Date;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function createNote(
  userId: number,
  muscleGroup: string,
  content: string,
): Promise<PersonalMuscleNote> {
  if (!muscleGroup || !content) {
    throw new ValidationError("Muscle group and content are required");
  }

  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) {
    throw new ValidationError("Note content cannot be empty");
  }

  const now = formatDateForMySQL(new Date());

  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(
    `INSERT INTO personal_muscle_notes (user_id, muscle_group, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, muscleGroup, trimmedContent, now, now],
  );

  const id = (result as unknown as InsertResult).insertId;
  return getNoteById(userId, id);
}

export async function getNoteById(
  userId: number,
  noteId: number,
): Promise<PersonalMuscleNote> {
  const [rows] = await dbQuery<PersonalNoteRow[]>(
    `SELECT * FROM personal_muscle_notes WHERE id = ? AND user_id = ?`,
    [noteId, userId],
  );
  if (!rows[0]) throw new NotFoundError("Note");
  return formatNote(rows[0]);
}

export async function updateNote(
  userId: number,
  noteId: number,
  content: string,
): Promise<PersonalMuscleNote> {
  // Verify note exists
  await getNoteById(userId, noteId);

  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) {
    throw new ValidationError("Note content cannot be empty");
  }

  const now = formatDateForMySQL(new Date());

  await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`UPDATE personal_muscle_notes SET content = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [
    trimmedContent,
    now,
    noteId,
    userId,
  ]);

  return getNoteById(userId, noteId);
}

export async function getAllNotes(
  userId: number,
): Promise<PersonalMuscleNote[]> {
  const [rows] = await dbQuery<PersonalNoteRow[]>(
    `SELECT * FROM personal_muscle_notes WHERE user_id = ? ORDER BY updated_at DESC`,
    [userId],
  );
  return rows.map(formatNote);
}

export async function getNotesByMuscle(
  userId: number,
  muscleGroup: string,
): Promise<PersonalMuscleNote[]> {
  const [rows] = await dbQuery<PersonalNoteRow[]>(
    `SELECT * FROM personal_muscle_notes WHERE user_id = ? AND muscle_group = ? ORDER BY updated_at DESC`,
    [userId, muscleGroup],
  );
  return rows.map(formatNote);
}

export async function deleteNote(
  userId: number,
  noteId: number,
): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`DELETE FROM personal_muscle_notes WHERE id = ? AND user_id = ?`, [
    noteId,
    userId,
  ]);
  return (result as unknown as InsertResult).affectedRows > 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatNote(row: PersonalNoteRow): PersonalMuscleNote {
  return {
    id: row.id,
    muscleGroup: row.muscle_group,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
