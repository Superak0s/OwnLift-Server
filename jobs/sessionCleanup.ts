// src/jobs/sessionCleanup.ts
//
// Server-side backstop for abandoned workout sessions.
//
// The client already has its own 30-minute inactivity auto-end
// (WorkoutContext's checkAndEndStaleSession), but that only runs while the
// app is open. If the user force-closes the app, the phone dies, or the OS
// kills the JS process mid-workout, that logic never fires and the session
// — and the day it belongs to — stays "open" in the DB indefinitely. This
// job is the server-side equivalent: it runs on its own schedule regardless
// of whether any client is connected, and closes anything that's gone
// quiet for too long.

import { findStaleOpenSessions, autoEndStaleSession } from "../models/workout.js"

// Keep this in sync with INACTIVITY_THRESHOLD_MS on the client
// (utils/session.ts) — both should represent the same 30-minute idea.
const INACTIVITY_THRESHOLD_MINUTES = 30

// How often the server checks for stale sessions. Doesn't need to be tight:
// a session that's 30-45 minutes stale instead of exactly 30 makes no
// practical difference, and this keeps DB load low.
const CHECK_INTERVAL_MS = 5 * 60 * 1000 // every 5 minutes

let cleanupTimer: ReturnType<typeof setInterval> | null = null
let isRunning = false // reentrancy guard in case a run overlaps its own interval

/**
 * Find and auto-end every session that's been inactive past the threshold.
 * Safe to call directly (e.g. from a manual admin route or a test) as well
 * as from the scheduled interval.
 */
export async function runStaleSessionCleanup(): Promise<{
  checked: number
  ended: number
}> {
  if (isRunning) {
    // A previous run is still in flight (e.g. slow DB) — skip this tick
    // rather than piling up overlapping queries.
    return { checked: 0, ended: 0 }
  }
  isRunning = true

  try {
    const stale = await findStaleOpenSessions(INACTIVITY_THRESHOLD_MINUTES)
    if (stale.length === 0) return { checked: 0, ended: 0 }

    console.log(
      `[SESSION_CLEANUP] Found ${stale.length} stale session(s) to auto-end`,
    )

    let ended = 0
    for (const row of stale) {
      try {
        await autoEndStaleSession(row.id, row.last_activity)
        ended += 1
        console.log(
          `[SESSION_CLEANUP] Auto-ended session ${row.id} (user ${row.user_id}), ` +
            `last activity ${new Date(row.last_activity).toISOString()}`,
        )
      } catch (err) {
        console.error(
          `[SESSION_CLEANUP] Failed to end session ${row.id}:`,
          (err as Error).message,
        )
      }
    }

    return { checked: stale.length, ended }
  } catch (err) {
    console.error(
      "[SESSION_CLEANUP] Cleanup run failed:",
      (err as Error).message,
    )
    return { checked: 0, ended: 0 }
  } finally {
    isRunning = false
  }
}

/**
 * Start the periodic cleanup job. Call this once at server startup, e.g. in
 * your main index.ts / server.ts right after the DB pool is ready:
 *
 *   import { startStaleSessionCleanup } from "./jobs/sessionCleanup"
 *   ...
 *   app.listen(PORT, () => {
 *     console.log(`Server running on port ${PORT}`)
 *     startStaleSessionCleanup()
 *   })
 */
export function startStaleSessionCleanup(): void {
  if (cleanupTimer) {
    console.warn("[SESSION_CLEANUP] Already running — ignoring duplicate start")
    return
  }

  // Run once immediately on boot to catch anything that went stale while
  // the server was down, then settle into the regular interval.
  void runStaleSessionCleanup()

  cleanupTimer = setInterval(() => {
    void runStaleSessionCleanup()
  }, CHECK_INTERVAL_MS)

  console.log(
    `[SESSION_CLEANUP] Scheduled every ${CHECK_INTERVAL_MS / 60000}m ` +
      `(inactivity threshold: ${INACTIVITY_THRESHOLD_MINUTES}m)`,
  )
}

/** Mainly useful for graceful shutdown / tests. */
export function stopStaleSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}
