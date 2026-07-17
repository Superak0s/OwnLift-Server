/**
 * types/program.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Workout-program domain: parsed program structure, day/person views, and the
 * program-service helper result shapes.
 */

export interface Exercise {
  name: string
  muscleGroup: string
  sets: number
}

/** Exercise row that also tracks per-person set counts (used in day views). */
export interface ExerciseWithSets {
  name: string
  muscleGroup: string
  setsByPerson: Record<string, number>
}

export interface PersonData {
  exercises: Exercise[]
  totalSets: number
}

export interface WorkoutDay {
  dayNumber: number | null
  dayTitle: string
  muscleGroups: string[]
  exercises: ExerciseWithSets[]
  split: Record<string, PersonData>
  peopleColumns?: PeopleColumn[]
}

export interface PersonWorkout {
  exercises: Exercise[]
  totalSets: number
}

export interface PeopleColumn {
  index: number
  name: string
}

export interface ProgramDay {
  dayNumber: number
  dayTitle: string
  muscleGroups: string[]
  /** Flat exercise list with per-person set counts — used by parser output. */
  exercises: ExerciseWithSets[]
  /** Per-person exercise lists — used at runtime. */
  split: Record<string, PersonWorkout>
  /** Transient: only present in parser output, stripped before DB storage. */
  peopleColumns?: PeopleColumn[]
}

export interface ProgramData {
  days: ProgramDay[]
  split: string[]
}

export interface StoredProgram {
  programData: ProgramData
  originalFilename: string
  uploadedAt: Date
}

// High-level program views
export interface PersonDayWorkout {
  person: string
  dayNumber: number
  dayTitle: string
  muscleGroups: string[]
  exercises: Exercise[]
  totalSets: number
}

export interface PersonPlan {
  person: string
  totalDays: number
  days: Omit<PersonDayWorkout, "person">[]
}

// ─── Program-service helper results ───────────────────────────────────────────

export interface DifficultyResult {
  difficulty: "beginner" | "intermediate" | "advanced"
  totalSets: number
  totalExercises: number
  daysPerWeek: number
  setsPerDay: number
  exercisesPerDay: number
}

export interface RecommendationEntry {
  type: "untrained_day" | "overdue"
  priority: "high" | "medium"
  message: string
  dayNumber: number
  dayTitle: string
  daysSince?: number
}

export interface ExerciseValidationResult {
  isValid: boolean
  warnings: Array<{
    type: string
    message: string
    recommendation: string
  }>
}

export interface SplitDay {
  name: string
  muscleGroups: string[]
}

export interface WorkoutSplit {
  name: string
  days: SplitDay[]
}

export interface ProgressionResult {
  hasProgression: boolean
  type?: "volume" | "weight" | "reps"
  message: string
  improvement?: number
}
