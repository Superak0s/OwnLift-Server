import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { pool } from "../../config/database.js"
import { createUser } from "../../features/auth/auth.model.js"
import { uniqueName } from "../../tests/helpers.js"
import {
  startStaleSessionCleanup,
  stopStaleSessionCleanup,
  runStaleSessionCleanup,
} from "../sessionCleanup.js"

// Only workouts idle for 30+ minutes are touched, so the fresh workouts other
// test files create are safe from this job running against the shared scratch DB.
describe("sessionCleanup", () => {
  let staleId: number
  let freshId: number

  async function openSession(startsMinutesAgo: number): Promise<number> {
    const username = uniqueName("clean")
    const userId = await createUser(
      username,
      `${username}@test.local`,
      "Passw0rd-123",
    )
    const [res] = await pool.execute(
      `INSERT INTO workouts (user_id, day_number, day_title, start_time)
       VALUES (?, 1, 'Cleanup day', NOW() - INTERVAL ? MINUTE)`,
      [userId, startsMinutesAgo],
    )
    return (res as { insertId: number }).insertId
  }

  beforeAll(async () => {
    staleId = await openSession(45)
    freshId = await openSession(1)
  })

  afterAll(async () => {
    stopStaleSessionCleanup()
    await pool.execute("DELETE FROM workouts WHERE id IN (?, ?)", [
      staleId,
      freshId,
    ])
  })

  it("ends workouts idle for 30+ minutes and leaves fresh ones alone", async () => {
    startStaleSessionCleanup() // runs once immediately, then every 5 min
    startStaleSessionCleanup() // idempotent — no second interval

    // The rest of the suite writes to `workouts` concurrently against the
    // shared scratch DB, and a sweep that collides with one of those writes
    // fails and waits 5 minutes for its next tick. Drive the sweep directly
    // and retry, rather than racing the scheduler's single immediate run.
    let stale: { end_time: string | null; total_duration: number } | undefined
    for (let attempt = 0; attempt < 10; attempt++) {
      await runStaleSessionCleanup()
      const [rows] = await pool.query(
        "SELECT end_time, total_duration FROM workouts WHERE id = ?",
        [staleId],
      )
      stale = (rows as typeof stale[])[0]
      if (stale?.end_time) break
      await new Promise((r) => setTimeout(r, 500))
    }

    expect(stale!.end_time).toBeTruthy()
    expect(stale!.total_duration).toBe(0)

    const [fresh] = await pool.query(
      "SELECT end_time FROM workouts WHERE id = ?",
      [freshId],
    )
    expect((fresh as { end_time: string | null }[])[0].end_time).toBeNull()
  })
})
