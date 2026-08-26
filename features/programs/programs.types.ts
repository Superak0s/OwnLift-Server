export interface Exercise {
  name: string
  muscleGroup: string
  sets: number
  /** Canonical id from the bundled exercise DB; null = custom exercise. */
  exerciseId?: string | null
}

/** Exercise row that also tracks per-split set counts (used in day views). */
interface ExerciseWithSets {
  name: string
  muscleGroup: string
  exerciseId?: string | null
  setsBySplit: Record<string, number>
}

interface SplitColumn {
  index: number
  name: string
}

export interface SplitWorkout {
  exercises: Exercise[]
  totalSets: number
}

export interface ProgramDay {
  dayNumber: number
  dayTitle: string
  muscleGroups: string[]
  /** Flat exercise list with per-split set counts — used by parser output. */
  exercises: ExerciseWithSets[]
  /** Per-split exercise lists — used at runtime. */
  split: Record<string, SplitWorkout>
  /** Transient: only present in parser output, stripped before DB storage. */
  splitColumns?: SplitColumn[]
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
