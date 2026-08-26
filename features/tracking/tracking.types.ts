// Types shared across more than one tracking sub-feature. A type used by a
// single feature lives in that feature's own model file instead.

export interface WeightEntry {
  id: number
  weight_kg: number
  recorded_at: Date
  note: string | null
  created_at: Date
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

export type FlowIntensity = "light" | "moderate" | "heavy"

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
