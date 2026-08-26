import { pool, formatDateForMySQL } from "@/config/database.js"
import type { FlowIntensity } from "../tracking.types.js"
import { ValidationError } from "@/middleware/errorHandler.js"

export async function setDayFlow(
  userId: number,
  dateIso: string,
  intensity: FlowIntensity = "moderate",
  note?: string | null,
): Promise<void> {
  const d = new Date(dateIso)
  if (isNaN(d.getTime())) throw new ValidationError("Invalid date")
  if (!["light", "moderate", "heavy"].includes(intensity))
    throw new ValidationError("Invalid intensity value")

  await pool.execute(
    `INSERT INTO menstrual_day_flow (user_id, date, intensity, note) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE intensity = VALUES(intensity), note = VALUES(note), updated_at = NOW()`,
    [userId, formatDateForMySQL(dateIso).slice(0, 10), intensity, note || null],
  )
}
