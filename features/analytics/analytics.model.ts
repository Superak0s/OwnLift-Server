import type { RowDataPacket } from "mysql2"
import { pool } from "@/config/database.js"

interface AnalyticsSummary extends RowDataPacket {
  avg_time_between_sets: number
  total_sessions: number
  total_sets: number
  total_volume: number
  avg_rest_time: number
  avg_set_duration: number
  first_session: Date | string | null
  last_session: Date | string | null
}

export async function getAnalytics(
  userId: number,
  split?: string | null,
  dayNumber?: number | null,
  days = 365,
): Promise<AnalyticsSummary> {
  let q = `
    SELECT
      COALESCE(ROUND(AVG(st.set_duration + COALESCE(st.rest_time, 0))), 120) AS avg_time_between_sets,
      COUNT(DISTINCT s.id) AS total_sessions,
      COUNT(st.id) AS total_sets,
      COALESCE(SUM(st.weight * st.reps), 0) AS total_volume,
      COALESCE(ROUND(AVG(st.rest_time)), 0) AS avg_rest_time,
      COALESCE(ROUND(AVG(st.set_duration)), 0) AS avg_set_duration,
      MIN(s.start_time) AS first_session,
      MAX(s.start_time) AS last_session
    FROM sessions s
    LEFT JOIN set_timings st ON s.id = st.session_id
    WHERE s.user_id = ? AND s.end_time IS NOT NULL
      AND s.start_time >= (NOW() - INTERVAL ? DAY)`
  const params: any[] = [userId, days]
  if (split) {
    q += ` AND s.\`split\` = ?`
    params.push(split)
  }
  // Use != null so dayNumber = 0 is still applied (falsy check would skip it)
  if (dayNumber != null) {
    q += ` AND s.day_number = ?`
    params.push(dayNumber)
  }
  const [rows] = await pool.execute<AnalyticsSummary[]>(q, params)
  return rows[0]
}
