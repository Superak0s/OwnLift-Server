/**
 * types/supplements.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic supplement tracking (definitions, logs, and location reminders).
 */

export interface Supplement {
  id: number
  userId: number
  name: string
  unit: string
  defaultAmount: number
  reminderEnabled: boolean
  reminderTime: string | null
  locationReminderEnabled: boolean
  color: string | null
  icon: string | null
  createdAt: Date
  updatedAt: Date
}

export interface SupplementSummary {
  id: number
  name: string
  unit: string
  defaultAmount: number
  reminderEnabled: boolean
  reminderTime: string | null
  locationReminderEnabled: boolean
  color: string | null
  icon: string | null
  takenToday: boolean
  streak: number
}

export interface SupplementEntry {
  id: number
  supplementId: number
  amount: number
  takenAt: Date
  note: string | null
  createdAt: Date
}

export interface SupplementLocation {
  id: number
  supplementId: number
  latitude: number
  longitude: number
  address: string
  radius: number
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

export interface CreateSupplementInput {
  name: string
  unit?: string
  defaultAmount?: number
  reminderEnabled?: boolean
  reminderTime?: string | null
  color?: string | null
  icon?: string | null
}

export interface UpdateSupplementInput extends Partial<CreateSupplementInput> {
  locationReminderEnabled?: boolean
}

export interface LogSupplementInput {
  amount?: number
  takenAt?: string | null
  note?: string | null
}

export interface SupplementLocationInput {
  latitude: number
  longitude: number
  address: string
  radius: number
}

export interface AtLocationResult {
  withinRadius: boolean
  reason?: string
  distance?: number
  radius?: number
  address?: string
}
