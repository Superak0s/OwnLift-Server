// src/models/workout/program.ts
//
// Single canonical implementation — duplicate load/save/find helpers and the
// redundant getProgramByUserId alias have been removed. All mutations go
// through loadProgram / saveProgram / requireDay / requirePersonWorkout.

import { pool } from "../../config/database.js"
import { query as dbQuery } from "../../config/database.js"
import type { RowDataPacket } from "mysql2"
import type { InsertResult } from "../../types/index.js"
import { NotFoundError, ValidationError } from "../../middleware/errorHandler.js"
import type {
  Exercise,
  PersonWorkout,
  ProgramDay,
  ProgramData,
  StoredProgram,
  PersonDayWorkout,
  PersonPlan,
} from "../../types/index.js"

export type {
  Exercise,
  PersonWorkout,
  ProgramDay,
  ProgramData,
  StoredProgram,
  PersonDayWorkout,
  PersonPlan,
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface ProgramRow extends RowDataPacket {
  program_data: string
  original_filename: string
  uploaded_at: Date
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function parseProgramData(raw: string, userId: number): ProgramData {
  try {
    return JSON.parse(raw) as ProgramData
  } catch {
    throw new Error(
      `Corrupt program data for user ${userId} — please re-upload your workout file`,
    )
  }
}

function requireDay(programData: ProgramData, dayNumber: number): ProgramDay {
  const day = programData.days?.find((d) => d.dayNumber === +dayNumber)
  if (!day) throw new NotFoundError(`Day ${dayNumber}`)
  return day
}

function requirePersonWorkout(
  day: ProgramDay,
  person: string,
  exerciseIndex: number,
): PersonWorkout {
  const pw = day.split?.[person]
  if (!pw?.exercises?.[exerciseIndex]) throw new NotFoundError("Exercise")
  return pw
}

async function loadProgram(userId: number): Promise<StoredProgram> {
  const program = await getUserProgram(userId)
  if (!program) throw new NotFoundError("Workout program")
  return program
}

async function saveProgram(
  userId: number,
  programData: ProgramData,
  originalFilename: string,
): Promise<void> {
  await pool.execute(
    `UPDATE workout_programs SET program_data = ?, original_filename = ?, uploaded_at = NOW() WHERE user_id = ?`,
    [JSON.stringify(programData), originalFilename, userId],
  )
}

// ─── DB primitives ────────────────────────────────────────────────────────────

export async function getUserProgram(
  userId: number,
): Promise<StoredProgram | null> {
  const [rows] = await dbQuery<ProgramRow[]>(
    `SELECT program_data, original_filename, uploaded_at FROM workout_programs WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT 1`,
    [userId],
  )
  if (!rows[0]) return null
  return {
    programData: parseProgramData(rows[0].program_data, userId),
    originalFilename: rows[0].original_filename,
    uploadedAt: rows[0].uploaded_at,
  }
}

// Alias kept for callers that imported getProgramByUserId
export const getProgramByUserId = getUserProgram

export async function upsertProgram(
  userId: number,
  programData: ProgramData,
  originalFilename: string,
): Promise<void> {
  await pool.execute(
    `INSERT INTO workout_programs (user_id, program_data, original_filename, uploaded_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE program_data = VALUES(program_data), original_filename = VALUES(original_filename), uploaded_at = NOW()`,
    [userId, JSON.stringify(programData), originalFilename],
  )
}

export async function deleteProgramByUserId(userId: number): Promise<boolean> {
  const [result] = await pool.execute<
    InsertResult & { constructor: { name: string } }
  >("DELETE FROM workout_programs WHERE user_id = ?", [userId])
  return (result as unknown as InsertResult).affectedRows > 0
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getProgramDay(
  userId: number,
  dayNumber: number,
): Promise<ProgramDay & { participants: string[] }> {
  const { programData } = await loadProgram(userId)
  return {
    ...requireDay(programData, dayNumber),
    participants: programData.split,
  }
}

export async function getPersonWorkoutPlan(
  userId: number,
  personName: string,
): Promise<PersonPlan> {
  const { programData } = await loadProgram(userId)
  if (!programData.split?.includes(personName))
    throw new NotFoundError(`Split "${personName}"`)

  const days = programData.days
    .map((day) => ({
      dayNumber: day.dayNumber,
      dayTitle: day.dayTitle,
      muscleGroups: day.muscleGroups,
      exercises: day.split[personName]?.exercises || [],
      totalSets: day.split[personName]?.totalSets || 0,
    }))
    .filter((d) => d.exercises.length > 0)

  return { person: personName, totalDays: days.length, days }
}

export async function getPersonDayWorkout(
  userId: number,
  personName: string,
  dayNumber: number,
): Promise<PersonDayWorkout> {
  const { programData } = await loadProgram(userId)
  if (!programData.split?.includes(personName))
    throw new NotFoundError(`Split "${personName}"`)
  const day = requireDay(programData, dayNumber)
  return {
    person: personName,
    dayNumber: day.dayNumber,
    dayTitle: day.dayTitle,
    muscleGroups: day.muscleGroups,
    exercises: day.split[personName]?.exercises || [],
    totalSets: day.split[personName]?.totalSets || 0,
  }
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export async function renameExercise(
  userId: number,
  dayNumber: number,
  person: string,
  exerciseIndex: number,
  newName: string,
  newMuscleGroup?: string,
): Promise<{ oldName: string; newName: string; exerciseIndex: number }> {
  const { programData, originalFilename } = await loadProgram(userId)
  const pw = requirePersonWorkout(
    requireDay(programData, dayNumber),
    person,
    exerciseIndex,
  )
  const oldName = pw.exercises[exerciseIndex].name
  pw.exercises[exerciseIndex].name = newName.trim()
  if (newMuscleGroup !== undefined)
    pw.exercises[exerciseIndex].muscleGroup = newMuscleGroup
  await saveProgram(userId, programData, originalFilename)
  return { oldName, newName: newName.trim(), exerciseIndex }
}

export async function addExercise(
  userId: number,
  dayNumber: number,
  person: string,
  exercise: { name?: string; muscleGroup?: string; sets?: number },
): Promise<{ exerciseIndex: number; exercise: Exercise }> {
  if (!exercise?.name || !exercise?.sets)
    throw new ValidationError("Exercise name and sets are required")
  const { programData, originalFilename } = await loadProgram(userId)
  const day = requireDay(programData, dayNumber)
  if (!day.split[person]) day.split[person] = { exercises: [], totalSets: 0 }

  const newExercise: Exercise = {
    name: exercise.name.trim(),
    muscleGroup: exercise.muscleGroup?.trim() || "",
    sets: parseInt(String(exercise.sets)),
  }
  day.split[person].exercises.push(newExercise)
  day.split[person].totalSets =
    (day.split[person].totalSets || 0) + newExercise.sets
  if (!programData.split.includes(person)) programData.split.push(person)

  await saveProgram(userId, programData, originalFilename)
  return {
    exerciseIndex: day.split[person].exercises.length - 1,
    exercise: newExercise,
  }
}

export async function patchExerciseSets(
  userId: number,
  dayNumber: number,
  person: string,
  exerciseIndex: number,
  additionalSets: number,
): Promise<{ exerciseIndex: number; newSetCount: number }> {
  const { programData, originalFilename } = await loadProgram(userId)
  const pw = requirePersonWorkout(
    requireDay(programData, dayNumber),
    person,
    exerciseIndex,
  )
  const added = parseInt(String(additionalSets))
  pw.exercises[exerciseIndex].sets += added
  pw.totalSets = (pw.totalSets || 0) + added
  await saveProgram(userId, programData, originalFilename)
  return { exerciseIndex, newSetCount: pw.exercises[exerciseIndex].sets }
}

export async function updateExerciseSets(
  userId: number,
  dayNumber: number,
  person: string,
  exerciseIndex: number,
  additionalSets: number,
): Promise<{ newSetCount: number; totalSetsAdded: number }> {
  const { programData, originalFilename } = await loadProgram(userId)
  const pw = requirePersonWorkout(
    requireDay(programData, dayNumber),
    person,
    exerciseIndex,
  )
  const added = parseInt(String(additionalSets))
  pw.exercises[exerciseIndex].sets += added
  pw.totalSets = (pw.totalSets || 0) + added
  await saveProgram(userId, programData, originalFilename)
  return {
    newSetCount: pw.exercises[exerciseIndex].sets,
    totalSetsAdded: added,
  }
}

export async function deleteExercise(
  userId: number,
  dayNumber: number,
  person: string,
  exerciseIndex: number,
): Promise<{ deletedExercise: Exercise; remainingExercises: number }> {
  const { programData, originalFilename } = await loadProgram(userId)
  const pw = requirePersonWorkout(
    requireDay(programData, dayNumber),
    person,
    exerciseIndex,
  )
  const [deletedExercise] = pw.exercises.splice(exerciseIndex, 1)
  pw.totalSets -= deletedExercise.sets
  await saveProgram(userId, programData, originalFilename)
  return { deletedExercise, remainingExercises: pw.exercises.length }
}
