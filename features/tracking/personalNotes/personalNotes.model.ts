// Personal Muscle Notes model

import { pool, formatDateForMySQL } from "@/config/database.js";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { ValidationError, NotFoundError } from "@/middleware/errorHandler.js";

// ─── Interfaces ───────────────────────────────────────────────────────────────

// Aliased to camelCase in SQL, so the query result is already the wire shape.
interface PersonalMuscleNote extends RowDataPacket {
  id: number;
  muscleGroup: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

const NOTE_COLS = `id, muscle_group AS muscleGroup, content,
       created_at AS createdAt, updated_at AS updatedAt`;

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

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO personal_muscle_notes (user_id, muscle_group, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, muscleGroup, trimmedContent, now, now],
  );

  const id = result.insertId;
  return getNoteById(userId, id);
}

async function getNoteById(
  userId: number,
  noteId: number,
): Promise<PersonalMuscleNote> {
  const [rows] = await pool.execute<PersonalMuscleNote[]>(
    `SELECT ${NOTE_COLS} FROM personal_muscle_notes WHERE id = ? AND user_id = ?`,
    [noteId, userId],
  );
  if (!rows[0]) throw new NotFoundError("Note");
  return rows[0];
}

export async function getNotesByMuscle(
  userId: number,
  muscleGroup: string,
): Promise<PersonalMuscleNote[]> {
  const [rows] = await pool.execute<PersonalMuscleNote[]>(
    `SELECT ${NOTE_COLS} FROM personal_muscle_notes WHERE user_id = ? AND muscle_group = ? ORDER BY updated_at DESC`,
    [userId, muscleGroup],
  );
  return rows;
}
