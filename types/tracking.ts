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

// ─── Body Measurements ────────────────────────────────────────────────────────

export interface MeasurementEntry {
  id: number
  waistCm?: number | null
  armLeftCm?: number | null
  armRightCm?: number | null
  chestCm?: number | null
  measuredAt: Date
  note?: string | null
  createdAt: Date
}

export interface MeasurementStats {
  current: Partial<MeasurementEntry> | null
  minWaist: number | null
  maxWaist: number | null
  minChest: number | null
  maxChest: number | null
  minArmLeft: number | null
  maxArmLeft: number | null
  entryCount: number
}

// ─── Hydration ────────────────────────────────────────────────────────────────

export interface HydrationEntry {
  id: number
  amountMl: number
  loggedAt: Date
  note?: string | null
  createdAt: Date
}

export interface HydrationStats {
  totalToday: number
  totalThisWeek: number
  totalThisMonth: number
  averageDaily: number
  entryCount: number
  lastEntry: HydrationEntry | null
}

// ─── Sleep ────────────────────────────────────────────────────────────────────

export type SleepQuality = "poor" | "fair" | "good" | "excellent"

export interface SleepEntry {
  id: number
  bedtime: Date
  wakeTime: Date
  durationHours: number
  quality: SleepQuality
  note?: string | null
  createdAt: Date
}

export interface SleepStats {
  averageDuration: number
  totalNights: number
  bestQuality: SleepQuality | null
  qualityCounts: Record<SleepQuality, number>
  lastEntry: SleepEntry | null
}

// ─── Muscle Soreness (DOMS) ───────────────────────────────────────────────────

export interface SorenessEntry {
  id: number
  muscleGroup: string
  intensity: number
  loggedAt: Date
  note?: string | null
  createdAt: Date
}

export interface SorenessMap {
  date: Date
  entries: Record<string, number>
}

export interface SorenessStats {
  mostSoreMuscle: { muscle: string; intensity: number } | null
  averageIntensity: number
  affectedMuscles: number
  lastEntry: SorenessEntry | null
}

// ─── Menstrual Cycle ──────────────────────────────────────────────────────────

export type FlowIntensity = "light" | "moderate" | "heavy"

export interface MenstrualEntry {
  id: number
  cycleStart: Date
  flowIntensity: FlowIntensity
  symptoms?: string[] | null
  createdAt: Date
  updatedAt: Date
}

export interface MenstrualDayFlowEntry {
  id: number
  cycleEntryId: number
  date: Date
  intensity: FlowIntensity
  note?: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CyclePhase {
  phase: "menstruation" | "follicular" | "ovulation" | "luteal"
  daysInPhase: number
  estimatedEnd: Date
}

export interface CycleStats {
  currentPhase: CyclePhase | null
  averageCycleLength: number
  nextPeriodEstimate: Date | null
  lastCycleEntry: MenstrualEntry | null
  predictedPeriodDates: Date[]
}

export interface MenstrualSettings {
  periodDays: number
  cycleLengthDays: number
  updatedAt?: Date | null
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
  muscleGroup?: string | null
  muscleNotes?: string | null
}

export interface PhotoData {
  photoData: Buffer
  mimeType: string
}

export interface PhotoComparison {
  before: PhotoMetadata
  after: PhotoMetadata
  daysBetween: number
}

// ─── Additional tracking types (settings and custom measurements) ─────────────

export interface HydrationSettings {
  goalMl: number
  measurementErrorPercent: number
  updatedAt?: Date | null
}

export interface CustomMeasurementType {
  id: number
  keyName: string
  label: string
  unit?: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CustomMeasurementEntry {
  id: number
  typeId: number
  typeLabel: string
  value: number
  measuredAt: Date
  note?: string | null
  createdAt: Date
}

// ─── Reminders ────────────────────────────────────────────────────────────────

export type ReminderType = "weigh_in" | "hydration" | "sleep" | "measurements" | "menstrual"
export type ReminderFrequency = "daily" | "weekly" | "custom"

export interface UserReminder {
  id: number
  reminderType: ReminderType
  enabled: boolean
  frequency: ReminderFrequency
  timeOfDay?: string | null
  dayOfWeek?: number | null
  createdAt: Date
  updatedAt: Date
}
