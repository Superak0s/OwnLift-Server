// src/models/tracking/progressPhoto.ts
// Progress Photo with muscle tagging (multi-muscle support)

import { pool } from "../../config/database.js";
import { query as dbQuery } from "../../config/database.js";
import type { RowDataPacket } from "mysql2";
import type { InsertResult } from "../../types/index.js";
import { formatDateForMySQL } from "../utils/dateHelpers.js";
import { NotFoundError, ValidationError } from "../../middleware/errorHandler.js";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export type PhotoAngle = "front" | "back" | "side" | "custom";

export interface ProgressPhotoMuscle {
  id: number;
  uri: string;
  takenAt: Date;
  notes: string | null;
  angle: PhotoAngle;
  muscleGroups: string[];
  createdAt: Date;
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface ProgressPhotoRow extends RowDataPacket {
  id: number;
  uri: string;
  taken_at: Date;
  notes: string | null;
  angle: string;
  created_at: Date;
}

interface MuscleTagRow extends RowDataPacket {
  muscle_group: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function uploadPhoto(
  userId: number,
  uri: string,
  muscleGroups: string[],
  notes?: string | null,
  angle?: PhotoAngle,
  takenAt?: string | null,
): Promise<ProgressPhotoMuscle> {
  if (!uri) {
    throw new ValidationError("Photo URI is required");
  }

  if (!Array.isArray(muscleGroups) || muscleGroups.length === 0) {
    throw new ValidationError("At least one muscle group is required");
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const ts = formatDateForMySQL(takenAt ? takenAt : new Date());
    const photoAngle = angle ?? "custom";

    const [result] = await connection.execute<
      InsertResult & { constructor: { name: string } }
    >(
      `INSERT INTO progress_photos_muscle (user_id, uri, taken_at, notes, angle, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, uri, ts, notes ?? null, photoAngle, formatDateForMySQL(new Date())],
    );

    const photoId = (result as unknown as InsertResult).insertId;

    // Insert muscle group tags
    for (const muscle of muscleGroups) {
      await connection.execute<
        InsertResult & { constructor: { name: string } }
      >(
        `INSERT INTO progress_photos_muscle_tags (photo_id, muscle_group) VALUES (?, ?)`,
        [photoId, muscle],
      );
    }

    await connection.commit();
    return getPhotoById(userId, photoId);
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

export async function getPhotoById(
  userId: number,
  photoId: number,
): Promise<ProgressPhotoMuscle> {
  const [rows] = await dbQuery<ProgressPhotoRow[]>(
    `SELECT * FROM progress_photos_muscle WHERE id = ? AND user_id = ?`,
    [photoId, userId],
  );
  if (!rows[0]) throw new NotFoundError("Photo");

  const muscleGroups = await getMuscleGroupsForPhoto(photoId);
  return formatProgressPhoto(rows[0], muscleGroups);
}

export async function getAllPhotos(
  userId: number,
  limit: number = 100,
): Promise<ProgressPhotoMuscle[]> {
  const [rows] = await dbQuery<ProgressPhotoRow[]>(
    `SELECT * FROM progress_photos_muscle WHERE user_id = ? ORDER BY taken_at DESC LIMIT ?`,
    [userId, limit],
  );

  const results: ProgressPhotoMuscle[] = [];
  for (const row of rows) {
    const muscleGroups = await getMuscleGroupsForPhoto(row.id);
    results.push(formatProgressPhoto(row, muscleGroups));
  }
  return results;
}

export async function getPhotosByMuscle(
  userId: number,
  muscle: string,
): Promise<ProgressPhotoMuscle[]> {
  const [rows] = await dbQuery<ProgressPhotoRow[]>(
    `SELECT pp.* FROM progress_photos_muscle pp
     INNER JOIN progress_photos_muscle_tags t ON t.photo_id = pp.id
     WHERE pp.user_id = ? AND t.muscle_group = ?
     ORDER BY pp.taken_at DESC`,
    [userId, muscle],
  );

  const results: ProgressPhotoMuscle[] = [];
  for (const row of rows) {
    const muscleGroups = await getMuscleGroupsForPhoto(row.id);
    results.push(formatProgressPhoto(row, muscleGroups));
  }
  return results;
}

export async function filterPhotosByMuscles(
  userId: number,
  muscleGroups: string[],
): Promise<ProgressPhotoMuscle[]> {
  if (muscleGroups.length === 0) {
    throw new ValidationError("At least one muscle group is required");
  }

  const placeholders = muscleGroups.map(() => "?").join(", ");
  const [rows] = await dbQuery<ProgressPhotoRow[]>(
    `SELECT DISTINCT pp.* FROM progress_photos_muscle pp
     INNER JOIN progress_photos_muscle_tags t ON t.photo_id = pp.id
     WHERE pp.user_id = ? AND t.muscle_group IN (${placeholders})
     ORDER BY pp.taken_at DESC`,
    [userId, ...muscleGroups],
  );

  const results: ProgressPhotoMuscle[] = [];
  for (const row of rows) {
    const muscleGroups = await getMuscleGroupsForPhoto(row.id);
    results.push(formatProgressPhoto(row, muscleGroups));
  }
  return results;
}

export async function getPhotosByDateRange(
  userId: number,
  startDate: string,
  endDate: string,
): Promise<ProgressPhotoMuscle[]> {
  const [rows] = await dbQuery<ProgressPhotoRow[]>(
    `SELECT * FROM progress_photos_muscle
     WHERE user_id = ? AND DATE(taken_at) BETWEEN ? AND ?
     ORDER BY taken_at DESC`,
    [userId, startDate, endDate],
  );

  const results: ProgressPhotoMuscle[] = [];
  for (const row of rows) {
    const muscleGroups = await getMuscleGroupsForPhoto(row.id);
    results.push(formatProgressPhoto(row, muscleGroups));
  }
  return results;
}

export async function deletePhoto(
  userId: number,
  photoId: number,
): Promise<boolean> {
  // Tags are cascade deleted via foreign key
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >(`DELETE FROM progress_photos_muscle WHERE id = ? AND user_id = ?`, [
    photoId,
    userId,
  ]);
  return (result as unknown as InsertResult).affectedRows > 0;
}

export async function updatePhotoTags(
  userId: number,
  photoId: number,
  muscleGroups: string[],
  notes?: string | null,
): Promise<ProgressPhotoMuscle> {
  // Verify photo exists
  await getPhotoById(userId, photoId);

  if (!Array.isArray(muscleGroups) || muscleGroups.length === 0) {
    throw new ValidationError("At least one muscle group is required");
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Remove existing tags
    await connection.execute<
      InsertResult & { constructor: { name: string } }
    >(`DELETE FROM progress_photos_muscle_tags WHERE photo_id = ?`, [photoId]);

    // Insert new tags
    for (const muscle of muscleGroups) {
      await connection.execute<
        InsertResult & { constructor: { name: string } }
      >(
        `INSERT INTO progress_photos_muscle_tags (photo_id, muscle_group) VALUES (?, ?)`,
        [photoId, muscle],
      );
    }

    // Update notes if provided
    if (notes !== undefined && notes !== null) {
      await connection.execute<
        InsertResult & { constructor: { name: string } }
      >(`UPDATE progress_photos_muscle SET notes = ? WHERE id = ? AND user_id = ?`, [
        notes,
        photoId,
        userId,
      ]);
    }

    await connection.commit();
    return getPhotoById(userId, photoId);
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getMuscleGroupsForPhoto(photoId: number): Promise<string[]> {
  const [rows] = await dbQuery<MuscleTagRow[]>(
    `SELECT muscle_group FROM progress_photos_muscle_tags WHERE photo_id = ? ORDER BY muscle_group`,
    [photoId],
  );
  return rows.map((r) => r.muscle_group);
}

function formatProgressPhoto(
  row: ProgressPhotoRow,
  muscleGroups: string[],
): ProgressPhotoMuscle {
  return {
    id: row.id,
    uri: row.uri,
    takenAt: row.taken_at,
    notes: row.notes,
    angle: row.angle as PhotoAngle,
    muscleGroups,
    createdAt: row.created_at,
  };
}
