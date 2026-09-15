// Single canonical implementation. All mutations go through
// loadProgram / saveProgram / requireDay / requireSplitWorkout.

import { pool } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import type {
  Exercise,
  MachineFields,
  SplitWorkout,
  ProgramDay,
  ProgramData,
  StoredProgram,
} from "./programs.types.js"

/** The only exercise keys patchExerciseMachine will write. */
export const MACHINE_FIELDS = [
  "machines",
  "selectedMachine",
  "defaultMachine",
  "bestAcrossMachines",
  "machineMeta",
] as const satisfies readonly (keyof MachineFields)[]

function parseProgramData(raw: string, userId: number): ProgramData {
  try {
    return normalizeProgram(JSON.parse(raw) as ProgramData)
  } catch {
    throw new Error(
      `Corrupt program data for user ${userId} — please re-upload your workout file`,
    )
  }
}

// Stored programs omit exerciseId entirely. Normalise on both store and read
// so an unmatched exercise always reads back as exerciseId: null rather than
// absent.
export function normalizeProgram(programData: ProgramData): ProgramData {
  for (const day of programData.days ?? []) {
    for (const ex of day.exercises ?? []) ex.exerciseId = ex.exerciseId ?? null
    for (const sw of Object.values(day.split ?? {}))
      for (const ex of sw.exercises ?? []) ex.exerciseId = ex.exerciseId ?? null
  }
  return programData
}

function requireDay(programData: ProgramData, dayNumber: number): ProgramDay {
  const day = programData.days?.find((d) => d.dayNumber === +dayNumber)
  if (!day) throw new NotFoundError(`Day ${dayNumber}`)
  return day
}

function requireSplitWorkout(
  day: ProgramDay,
  split: string,
  exerciseIndex: number,
): SplitWorkout {
  const pw = day.split?.[split]
  if (!pw?.exercises?.[exerciseIndex]) throw new NotFoundError("Exercise")
  return pw
}

// ponytail: read-modify-write with no row lock — two concurrent PATCHes from
// the same user (two tabs/devices) can lose a write. Add SELECT ... FOR UPDATE
// in a transaction if that's ever reported.
async function loadProgram(userId: number): Promise<StoredProgram> {
  const program = await getProgramByUserId(userId)
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

export async function getProgramByUserId(
  userId: number,
): Promise<StoredProgram | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    // user_id is the primary key, so there is never more than one row — the
    // ORDER BY that used to be here sorted a single-row result set.
    `SELECT program_data, original_filename, uploaded_at FROM workout_programs WHERE user_id = ?`,
    [userId],
  )
  if (!rows[0]) return null
  return {
    programData: parseProgramData(rows[0].program_data, userId),
    originalFilename: rows[0].original_filename,
    uploadedAt: rows[0].uploaded_at,
  }
}

export async function upsertProgram(
  userId: number,
  programData: ProgramData,
  originalFilename: string,
): Promise<void> {
  normalizeProgram(programData)
  await pool.execute(
    `INSERT INTO workout_programs (user_id, program_data, original_filename, uploaded_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE program_data = VALUES(program_data), original_filename = VALUES(original_filename), uploaded_at = NOW()`,
    [userId, JSON.stringify(programData), originalFilename],
  )
}

export async function deleteProgramByUserId(userId: number): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>("DELETE FROM workout_programs WHERE user_id = ?", [userId])
  return result.affectedRows > 0
}

export async function renameExercise(
  userId: number,
  dayNumber: number,
  split: string,
  exerciseIndex: number,
  newName: string,
  newPrimaryMuscles?: string[],
  newSecondaryMuscles?: string[],
  newExerciseId?: string | null,
): Promise<{ oldName: string; newName: string; exerciseIndex: number }> {
  const { programData, originalFilename } = await loadProgram(userId)
  const pw = requireSplitWorkout(
    requireDay(programData, dayNumber),
    split,
    exerciseIndex,
  )
  const oldName = pw.exercises[exerciseIndex].name
  pw.exercises[exerciseIndex].name = newName.trim()
  if (newPrimaryMuscles !== undefined)
    pw.exercises[exerciseIndex].primaryMuscles = newPrimaryMuscles
  if (newSecondaryMuscles !== undefined)
    pw.exercises[exerciseIndex].secondaryMuscles = newSecondaryMuscles
  // Explicit null is how a matched exercise is turned back into a custom one.
  if (newExerciseId !== undefined)
    pw.exercises[exerciseIndex].exerciseId = newExerciseId?.trim() || null
  await saveProgram(userId, programData, originalFilename)
  return { oldName, newName: newName.trim(), exerciseIndex }
}

export async function addExercise(
  userId: number,
  dayNumber: number,
  split: string,
  exercise: {
    name?: string
    sets?: number
    primaryMuscles?: string[]
    secondaryMuscles?: string[]
    reps?: string
    exerciseId?: string | null
  },
): Promise<{ exerciseIndex: number; exercise: Exercise }> {
  if (!exercise?.name || !exercise?.sets)
    throw new ValidationError("Exercise name and sets are required")
  const { programData, originalFilename } = await loadProgram(userId)
  const day = requireDay(programData, dayNumber)
  if (!day.split[split]) day.split[split] = { exercises: [], totalSets: 0 }

  const sets = parseInt(String(exercise.sets))
  if (isNaN(sets)) throw new ValidationError("sets must be a number")

  const newExercise: Exercise = {
    name: exercise.name.trim(),
    primaryMuscles: exercise.primaryMuscles ?? [],
    secondaryMuscles: exercise.secondaryMuscles ?? [],
    sets,
    // Free text ("10", "8-12", even "0") — trimmed, stored as given, or
    // omitted when absent/blank. Never a validation failure.
    reps: exercise.reps?.trim() || undefined,
    exerciseId: exercise.exerciseId?.trim() || null,
  }
  day.split[split].exercises.push(newExercise)
  day.split[split].totalSets =
    (day.split[split].totalSets || 0) + newExercise.sets
  if (!programData.split.includes(split)) programData.split.push(split)

  await saveProgram(userId, programData, originalFilename)
  return {
    exerciseIndex: day.split[split].exercises.length - 1,
    exercise: newExercise,
  }
}

/**
 * Targeted machine-settings patch. Exists so trainer mode has a way to change
 * a trainee's machine setup without `POST /program/upload`, which is a whole-
 * program replace and is therefore `denyTrainer`-gated: a trainer holding a
 * stale copy of the program would otherwise overwrite edits the trainee made
 * in the meantime. Only the keys in MACHINE_FIELDS are copied, so this cannot
 * be used to rewrite exercise names, sets, or anything else in the program.
 */
export async function patchExerciseMachine(
  userId: number,
  dayNumber: number,
  split: string,
  exerciseIndex: number,
  patch: MachineFields,
): Promise<{ exerciseIndex: number }> {
  const { programData, originalFilename } = await loadProgram(userId)
  const pw = requireSplitWorkout(
    requireDay(programData, dayNumber),
    split,
    exerciseIndex,
  )
  // An explicit undefined clears the field; an absent key leaves it alone. The
  // app sends partial patches (just `selectedMachine`, say) all the time.
  Object.assign(
    pw.exercises[exerciseIndex],
    Object.fromEntries(
      MACHINE_FIELDS.filter((k) => k in patch).map((k) => [k, patch[k]]),
    ),
  )
  await saveProgram(userId, programData, originalFilename)
  return { exerciseIndex }
}

export async function patchExerciseSets(
  userId: number,
  dayNumber: number,
  split: string,
  exerciseIndex: number,
  additionalSets: number,
): Promise<{ exerciseIndex: number; newSetCount: number }> {
  const { programData, originalFilename } = await loadProgram(userId)
  const pw = requireSplitWorkout(
    requireDay(programData, dayNumber),
    split,
    exerciseIndex,
  )
  const added = parseInt(String(additionalSets))
  if (isNaN(added)) throw new ValidationError("additionalSets must be a number")
  pw.exercises[exerciseIndex].sets += added
  pw.totalSets = (pw.totalSets || 0) + added
  await saveProgram(userId, programData, originalFilename)
  return { exerciseIndex, newSetCount: pw.exercises[exerciseIndex].sets }
}
