// The workout program, relationally.
//
// This used to be one `workout_programs.program_data` JSON blob per user: every
// edit read the whole program into Node, mutated an object, and wrote the whole
// thing back, and the exercise names in it had no connection to the `exercises`
// catalog every recorded set already pointed at. Now a program is
// programs → program_days → program_exercises → exercises, and a rename or a
// set-count change is an UPDATE of one row.
//
// GET /api/program still returns exactly the shape the app has always read;
// toProgramData below is where the rows become that shape again.

import { pool } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { PoolConnection } from "mysql2/promise"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import type {
  Exercise,
  MachineFields,
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

const asStrings = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []

// ─── Read ─────────────────────────────────────────────────────────────────────

interface ProgramRow extends RowDataPacket {
  id: number
  originalFilename: string
  splitOrder: unknown
  uploadedAt: string
}

interface DayRow extends RowDataPacket {
  id: number
  dayNumber: number
  dayTitle: string
  primaryMuscles: unknown
  secondaryMuscles: unknown
}

interface SlotRow extends RowDataPacket {
  programDayId: number
  splitName: string
  position: number
  name: string
  primaryMuscles: unknown
  secondaryMuscles: unknown
  exerciseId: string | null
  sets: number
  reps: string | null
  machine: Record<string, unknown> | null
}

export async function getProgramByUserId(
  userId: number,
): Promise<StoredProgram | null> {
  const [programs] = await pool.execute<ProgramRow[]>(
    `SELECT id, original_filename AS originalFilename,
            split_order AS splitOrder, uploaded_at AS uploadedAt
     FROM programs WHERE user_id = ?`,
    [userId],
  )
  const program = programs[0]
  if (!program) return null

  const [[days], [slots]] = await Promise.all([
    pool.execute<DayRow[]>(
      `SELECT id, day_number AS dayNumber, title AS dayTitle,
              primary_muscles AS primaryMuscles,
              secondary_muscles AS secondaryMuscles
       FROM program_days WHERE program_id = ? ORDER BY day_number ASC`,
      [program.id],
    ),
    pool.execute<SlotRow[]>(
      `SELECT pe.program_day_id AS programDayId, pe.split_name AS splitName,
              pe.position, e.name,
              e.primary_muscles AS primaryMuscles,
              e.secondary_muscles AS secondaryMuscles,
              pe.catalog_id AS exerciseId, pe.target_sets AS sets,
              pe.target_reps AS reps, pe.machine
       FROM program_exercises pe
       JOIN program_days pd ON pd.id = pe.program_day_id
       JOIN exercises e ON e.id = pe.exercise_id
       WHERE pd.program_id = ?
       ORDER BY pe.split_name ASC, pe.position ASC`,
      [program.id],
    ),
  ])

  return {
    programData: toProgramData(program, days, slots),
    originalFilename: program.originalFilename,
    uploadedAt: program.uploadedAt,
  }
}

/** Rows → the JSON the app has always received. */
function toProgramData(
  program: ProgramRow,
  days: DayRow[],
  slots: SlotRow[],
): ProgramData {
  const byDay = new Map<number, SlotRow[]>()
  for (const slot of slots) {
    const list = byDay.get(slot.programDayId)
    if (list) list.push(slot)
    else byDay.set(slot.programDayId, [slot])
  }

  return {
    split: asStrings(program.splitOrder),
    days: days.map((day): ProgramDay => {
      const daySlots = byDay.get(day.id) ?? []
      const split: ProgramDay["split"] = {}
      // Flat list, in first-seen order, with the per-split set counts the day
      // view reads. Derived here rather than stored twice.
      const flat = new Map<string, ProgramDay["exercises"][number]>()

      for (const slot of daySlots) {
        const exercise: Exercise = {
          name: slot.name,
          primaryMuscles: asStrings(slot.primaryMuscles),
          secondaryMuscles: asStrings(slot.secondaryMuscles),
          sets: slot.sets,
          ...(slot.reps ? { reps: slot.reps } : {}),
          exerciseId: slot.exerciseId,
          ...(slot.machine ?? {}),
        }
        const sw = (split[slot.splitName] ??= { exercises: [], totalSets: 0 })
        sw.exercises.push(exercise)
        sw.totalSets += slot.sets

        const seen = flat.get(slot.name)
        if (seen) seen.setsBySplit[slot.splitName] = slot.sets
        else
          flat.set(slot.name, {
            name: slot.name,
            primaryMuscles: exercise.primaryMuscles!,
            secondaryMuscles: exercise.secondaryMuscles!,
            ...(slot.reps ? { reps: slot.reps } : {}),
            exerciseId: slot.exerciseId,
            setsBySplit: { [slot.splitName]: slot.sets },
          })
      }

      return {
        dayNumber: day.dayNumber,
        dayTitle: day.dayTitle,
        primaryMuscles: asStrings(day.primaryMuscles),
        secondaryMuscles: asStrings(day.secondaryMuscles),
        exercises: [...flat.values()],
        split,
      }
    }),
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Catalog ids for every name in one round trip, creating the rows that don't
 * exist yet. Muscle groups are only written when the upload supplies them, so a
 * re-upload that omits them doesn't blank the catalog for everyone.
 */
async function catalogIds(
  connection: PoolConnection,
  exercises: Map<string, { primaryMuscles: string[]; secondaryMuscles: string[] }>,
): Promise<Map<string, number>> {
  const names = [...exercises.keys()]
  if (!names.length) return new Map()

  await connection.execute(
    `INSERT INTO exercises (name, primary_muscles, secondary_muscles) VALUES
     ${names.map(() => "(?, ?, ?)").join(", ")}
     ON DUPLICATE KEY UPDATE
       primary_muscles = IF(JSON_LENGTH(VALUES(primary_muscles)) > 0,
                            VALUES(primary_muscles), primary_muscles),
       secondary_muscles = IF(JSON_LENGTH(VALUES(secondary_muscles)) > 0,
                              VALUES(secondary_muscles), secondary_muscles)`,
    names.flatMap((name) => {
      const e = exercises.get(name)!
      return [
        name,
        JSON.stringify(e.primaryMuscles),
        JSON.stringify(e.secondaryMuscles),
      ]
    }),
  )

  const [rows] = await connection.execute<
    (RowDataPacket & { id: number; name: string })[]
  >(
    `SELECT id, name FROM exercises WHERE name IN (${names.map(() => "?").join(", ")})`,
    names,
  )
  return new Map(rows.map((r) => [r.name, r.id]))
}

/**
 * Replace the caller's program with this one. Days are upserted on
 * (program_id, day_number) rather than deleted and recreated, so a workout's
 * program_day_id survives a re-upload of the same day and its history keeps its
 * muscle labels.
 */
export async function upsertProgram(
  userId: number,
  programData: ProgramData,
  originalFilename: string,
): Promise<void> {
  const days = programData.days ?? []

  // Every exercise named anywhere in the upload, with the best muscle groups
  // the payload offers for it.
  const catalog = new Map<
    string,
    { primaryMuscles: string[]; secondaryMuscles: string[] }
  >()
  for (const day of days)
    for (const sw of Object.values(day.split ?? {}))
      for (const ex of sw.exercises ?? []) {
        const name = ex.name?.trim()
        if (!name) throw new ValidationError("Every exercise needs a name")
        const existing = catalog.get(name)
        catalog.set(name, {
          primaryMuscles: ex.primaryMuscles?.length
            ? ex.primaryMuscles
            : (existing?.primaryMuscles ?? []),
          secondaryMuscles: ex.secondaryMuscles?.length
            ? ex.secondaryMuscles
            : (existing?.secondaryMuscles ?? []),
        })
      }

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    const [programResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO programs (user_id, original_filename, split_order)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id),
         original_filename = VALUES(original_filename),
         split_order = VALUES(split_order), uploaded_at = NOW()`,
      [userId, originalFilename, JSON.stringify(programData.split ?? [])],
    )
    const programId = programResult.insertId
    const ids = await catalogIds(connection, catalog)

    for (const day of days) {
      const [dayResult] = await connection.execute<ResultSetHeader>(
        `INSERT INTO program_days
           (program_id, day_number, title, primary_muscles, secondary_muscles)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), title = VALUES(title),
           primary_muscles = VALUES(primary_muscles),
           secondary_muscles = VALUES(secondary_muscles)`,
        [
          programId,
          day.dayNumber,
          day.dayTitle ?? "",
          JSON.stringify(day.primaryMuscles ?? []),
          JSON.stringify(day.secondaryMuscles ?? []),
        ],
      )
      const dayId = dayResult.insertId

      // The slots themselves are disposable — nothing references them — so the
      // simple thing is right: clear the day and write what was uploaded.
      await connection.execute(
        `DELETE FROM program_exercises WHERE program_day_id = ?`,
        [dayId],
      )

      const slots = Object.entries(day.split ?? {}).flatMap(([splitName, sw]) =>
        (sw.exercises ?? []).map((ex, position) => [
          dayId,
          splitName,
          position,
          ids.get(ex.name.trim())!,
          ex.exerciseId?.trim() || null,
          Number(ex.sets) || 0,
          ex.reps?.trim() || null,
          JSON.stringify(machineOf(ex)),
        ]),
      )
      if (slots.length)
        await connection.execute(
          `INSERT INTO program_exercises
             (program_day_id, split_name, position, exercise_id, catalog_id,
              target_sets, target_reps, machine)
           VALUES ${slots.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
          slots.flat(),
        )
    }

    // Days the upload dropped. ON DELETE SET NULL on workouts.program_day_id
    // means their history survives, unlabelled.
    await connection.execute(
      days.length
        ? `DELETE FROM program_days WHERE program_id = ?
             AND day_number NOT IN (${days.map(() => "?").join(", ")})`
        : `DELETE FROM program_days WHERE program_id = ?`,
      [programId, ...days.map((d) => d.dayNumber)],
    )

    await connection.commit()
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
}

/** The machine sub-object of an exercise, separated from its program fields. */
function machineOf(exercise: Exercise): Record<string, unknown> {
  return Object.fromEntries(
    MACHINE_FIELDS.filter((k) => exercise[k] !== undefined).map((k) => [
      k,
      exercise[k],
    ]),
  )
}

export async function deleteProgramByUserId(userId: number): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM programs WHERE user_id = ?`,
    [userId],
  )
  return result.affectedRows > 0
}

// ─── Targeted edits ───────────────────────────────────────────────────────────

interface SlotIdRow extends RowDataPacket {
  id: number
  programDayId: number
  name: string
  sets: number
}

/**
 * The one program_exercises row a client addresses by (day, split, index), with
 * ownership proved by the join back to programs.user_id.
 */
async function requireSlot(
  userId: number,
  dayNumber: number,
  split: string,
  exerciseIndex: number,
): Promise<SlotIdRow> {
  const [rows] = await pool.execute<SlotIdRow[]>(
    `SELECT pe.id, pe.program_day_id AS programDayId, e.name,
            pe.target_sets AS sets
     FROM program_exercises pe
     JOIN program_days pd ON pd.id = pe.program_day_id
     JOIN programs p ON p.id = pd.program_id
     JOIN exercises e ON e.id = pe.exercise_id
     WHERE p.user_id = ? AND pd.day_number = ? AND pe.split_name = ?
       AND pe.position = ?`,
    [userId, dayNumber, split, exerciseIndex],
  )
  if (!rows[0]) throw new NotFoundError("Exercise")
  return rows[0]
}

async function requireDayId(userId: number, dayNumber: number): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT pd.id FROM program_days pd
     JOIN programs p ON p.id = pd.program_id
     WHERE p.user_id = ? AND pd.day_number = ?`,
    [userId, dayNumber],
  )
  if (!rows[0]) throw new NotFoundError(`Day ${dayNumber}`)
  return rows[0].id
}

/** Catalog id for a name, creating the row on first sighting. */
async function findOrCreateExercise(
  name: string,
  primaryMuscles?: string[],
  secondaryMuscles?: string[],
): Promise<number> {
  const [hit] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM exercises WHERE name = ?`,
    [name],
  )
  if (hit[0]) {
    if (primaryMuscles !== undefined || secondaryMuscles !== undefined)
      await pool.execute(
        `UPDATE exercises SET primary_muscles = COALESCE(?, primary_muscles),
                              secondary_muscles = COALESCE(?, secondary_muscles)
         WHERE id = ?`,
        [
          primaryMuscles ? JSON.stringify(primaryMuscles) : null,
          secondaryMuscles ? JSON.stringify(secondaryMuscles) : null,
          hit[0].id,
        ],
      )
    return hit[0].id
  }

  // LAST_INSERT_ID returns the id atomically whether this inserts or hits the
  // duplicate-key branch, which covers two requests both missing the SELECT.
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO exercises (name, primary_muscles, secondary_muscles)
     VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [
      name,
      JSON.stringify(primaryMuscles ?? []),
      JSON.stringify(secondaryMuscles ?? []),
    ],
  )
  return result.insertId
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
  const slot = await requireSlot(userId, dayNumber, split, exerciseIndex)
  const trimmed = newName.trim()
  const exerciseId = await findOrCreateExercise(
    trimmed,
    newPrimaryMuscles,
    newSecondaryMuscles,
  )

  await pool.execute(
    // Absent newExerciseId leaves the stored catalog id alone; explicit null
    // clears it, which is how a matched exercise becomes a custom one again.
    newExerciseId === undefined
      ? `UPDATE program_exercises SET exercise_id = ? WHERE id = ?`
      : `UPDATE program_exercises SET exercise_id = ?, catalog_id = ? WHERE id = ?`,
    newExerciseId === undefined
      ? [exerciseId, slot.id]
      : [exerciseId, newExerciseId?.trim() || null, slot.id],
  )
  return { oldName: slot.name, newName: trimmed, exerciseIndex }
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
  const sets = Number(exercise.sets)
  if (!Number.isInteger(sets) || sets < 0)
    throw new ValidationError("sets must be a non-negative integer")

  const dayId = await requireDayId(userId, dayNumber)
  const name = exercise.name.trim()
  const catalogRowId = await findOrCreateExercise(
    name,
    exercise.primaryMuscles,
    exercise.secondaryMuscles,
  )

  // The position is computed inside the INSERT so two adds to the same day
  // can't both read the same MAX and collide on the unique (day, position)
  // pair.
  const reps = exercise.reps?.trim() || null
  const catalogId = exercise.exerciseId?.trim() || null
  const [inserted] = await pool.execute<ResultSetHeader>(
    `INSERT INTO program_exercises
       (program_day_id, split_name, position, exercise_id, catalog_id,
        target_sets, target_reps)
     SELECT ?, ?, COALESCE(MAX(position) + 1, 0), ?, ?, ?, ?
     FROM program_exercises
     WHERE program_day_id = ? AND split_name = ?`,
    [dayId, split, catalogRowId, catalogId, sets, reps, dayId, split],
  )
  const [[insertedRow]] = await pool.execute<
    (RowDataPacket & { position: number })[]
  >(`SELECT position FROM program_exercises WHERE id = ?`, [inserted.insertId])
  const position = insertedRow.position

  // A split the program didn't list yet — append it, without rewriting the
  // array in Node.
  await pool.execute(
    `UPDATE programs SET split_order = JSON_ARRAY_APPEND(split_order, '$', ?)
     WHERE user_id = ? AND NOT JSON_CONTAINS(split_order, JSON_QUOTE(?))`,
    [split, userId, split],
  )

  return {
    exerciseIndex: position,
    exercise: {
      name,
      primaryMuscles: exercise.primaryMuscles ?? [],
      secondaryMuscles: exercise.secondaryMuscles ?? [],
      sets,
      // Free text ("10", "8-12", even "0") — stored as given, or omitted when
      // absent. Never a validation failure.
      ...(reps ? { reps } : {}),
      exerciseId: catalogId,
    },
  }
}

/**
 * Targeted machine-settings patch. Exists so trainer mode has a way to change a
 * trainee's machine setup without `POST /program/upload`, which is a whole-
 * program replace and is therefore `denyTrainer`-gated. Only the keys in
 * MACHINE_FIELDS are merged, so this cannot rewrite names, sets, or anything
 * else in the program.
 */
export async function patchExerciseMachine(
  userId: number,
  dayNumber: number,
  split: string,
  exerciseIndex: number,
  patch: MachineFields,
): Promise<{ exerciseIndex: number }> {
  const slot = await requireSlot(userId, dayNumber, split, exerciseIndex)

  // JSON_MERGE_PATCH drops a key whose new value is null, which is how the app
  // clears a setting; an absent key is left alone. JSON.stringify would drop an
  // explicit undefined entirely, so map it to null first.
  const merge = Object.fromEntries(
    MACHINE_FIELDS.filter((k) => k in patch).map((k) => [k, patch[k] ?? null]),
  )
  await pool.execute(
    `UPDATE program_exercises SET machine = JSON_MERGE_PATCH(machine, ?) WHERE id = ?`,
    [JSON.stringify(merge), slot.id],
  )
  return { exerciseIndex }
}

export async function patchExerciseSets(
  userId: number,
  dayNumber: number,
  split: string,
  exerciseIndex: number,
  additionalSets: number,
): Promise<{ exerciseIndex: number; newSetCount: number }> {
  const added = parseInt(String(additionalSets))
  if (isNaN(added)) throw new ValidationError("additionalSets must be a number")

  const slot = await requireSlot(userId, dayNumber, split, exerciseIndex)
  const newSetCount = slot.sets + added
  // ck_pe_sets stops a set count going negative; say so in the caller's terms.
  if (newSetCount < 0)
    throw new ValidationError("An exercise cannot have fewer than 0 sets")

  await pool.execute(
    `UPDATE program_exercises SET target_sets = ? WHERE id = ?`,
    [newSetCount, slot.id],
  )
  return { exerciseIndex, newSetCount }
}
