// Types shared across more than one tracking sub-feature. A type used by a
// single feature lives in that feature's own model file instead.

export interface WeightEntry {
  id: number
  weightKg: number
  recordedAt: Date
  note: string | null
  createdAt: Date
}

export interface BodyFatEntry {
  id: number
  percentage: number
  measurements: {
    waist: number
    neck: number
    hip: number | null
    height: number
    unit: string
  }
  date: Date
  method: string
  gender: string
}

export interface MacrosEntry {
  id: number
  name: string | null
  protein: number | null
  carbs: number | null
  fat: number | null
  calories: number | null
  errorMargin: number
  time: string
  date: string
  takenAt: Date
  note: string | null
}

export interface MacrosGoals {
  protein: number
  carbs: number
  fat: number
  calories: number
}
