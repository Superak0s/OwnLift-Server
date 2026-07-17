// src/models/utils/dateHelpers.ts

/**
 * Formats a Date or date string as a MySQL DATETIME string (YYYY-MM-DD HH:MM:SS).
 * Uses UTC methods so the stored value matches UTC regardless of the server's
 * local timezone setting. Ensure MySQL is also configured to use UTC
 * (set time_zone = '+00:00' in my.cnf or via SET GLOBAL time_zone).
 */
export function formatDateForMySQL(date: string | Date): string {
  const d = date instanceof Date ? date : new Date(date)
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  )
}

export const nowMySQL = (): string => formatDateForMySQL(new Date())

export const mysqlTimeToSimple = (t: string): string =>
  t.toString().split(":").slice(0, 2).join(":")

export const simpleTimeToMySQL = (t: string): string => {
  const [h = "00", m = "00"] = t.split(":")
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}:00`
}

export const todayDate = (): string =>
  new Date().toISOString().split("T")[0]

export function parseDate(date: string | Date): Date {
  const parsed = new Date(date)
  if (isNaN(parsed.getTime())) throw new Error(`Invalid date: ${date}`)
  return parsed
}
