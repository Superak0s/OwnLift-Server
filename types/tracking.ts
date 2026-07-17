/**
 * types/tracking.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Body-composition, macros, creatine, and progress-photo tracking shapes.
 */

// ─── Body tracking ────────────────────────────────────────────────────────────

export interface WeightEntry {
  id: number
  weight_kg: number
  recorded_at: Date
  note: string | null
  created_at: Date
}

export interface WeightStats {
  minWeight: number | null
  maxWeight: number | null
  avgWeight: number | null
  currentWeight: number | null
  entryCount: number
  change: number | null
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

export type BodyFatTrendDirection = "stable" | "increasing" | "decreasing"

export interface BodyFatTrend {
  trend:
    | "insufficient_data"
    | {
        direction: BodyFatTrendDirection
        totalChange: number
        totalChangePercent: number
        changePerWeek: number
        firstMeasurement: number
        lastMeasurement: number
        measurements: number
        timeSpan: number
      }
  entries?: number
  data: { percentage: number; date: Date }[]
}

// ─── Macros ───────────────────────────────────────────────────────────────────

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

export interface MacrosStat {
  total: number
  min: number
  max: number
  goal: number
  percentage: number
}

export interface MacrosGoals {
  protein: number
  carbs: number
  fat: number
  calories: number
}

export interface DailySummary {
  date: string
  protein: MacrosStat | null
  carbs: MacrosStat | null
  fat: MacrosStat | null
  calories: MacrosStat | null
  entries: number
  entriesList: Omit<MacrosEntry, "date" | "takenAt" | "errorMargin">[]
}

// ─── Creatine ─────────────────────────────────────────────────────────────────

export interface CreatineSettings {
  enabled: boolean
  reminderTime: string
  defaultGrams: number
}

export interface CreatineEntry {
  id: number
  grams: number
  taken_at: Date
  note: string | null
  created_at?: Date
}

export interface ReminderLocation {
  latitude: number
  longitude: number
  address: string
  radius: number
  enabled?: boolean
}

// ─── Photos ───────────────────────────────────────────────────────────────────

export interface PhotoMetadata {
  id: number
  mimeType: string
  fileSize: number
  takenAt: Date
  note: string | null
  createdAt: Date
  url: string
}

export interface PhotoData {
  photoData: Buffer
  mimeType: string
}
