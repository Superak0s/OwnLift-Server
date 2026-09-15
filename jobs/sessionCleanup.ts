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

import { endStaleSessions } from "../features/workouts/workouts.model.js"
import { logger } from "../utils/logger.js"

// Keep this in sync with INACTIVITY_THRESHOLD_MS on the client
// (utils/session.ts) — both should represent the same 30-minute idea.
const INACTIVITY_THRESHOLD_MINUTES = 30

// How often the server checks for stale sessions. Doesn't need to be tight:
// a session that's 30-45 minutes stale instead of exactly 30 makes no
// practical difference, and this keeps DB load low.
const CHECK_INTERVAL_MS = 5 * 60 * 1000

let cleanupTimer: ReturnType<typeof setInterval> | null = null

// One idempotent statement, so an overlapping run is harmless — the second
// one simply matches no rows.
//
// Exported so the test can drive a sweep directly. The scheduler runs this
// once on start and then only every 5 minutes, and against a DB with
// concurrent writers a single sweep can lose a race on `workouts` ("Record
// has changed since last read"), log it, and legitimately do nothing until
// the next tick — which is fine in production and makes any test that polls
// for a fixed window after start racy by construction.
export async function runStaleSessionCleanup(): Promise<void> {
  try {
    const ended = await endStaleSessions(INACTIVITY_THRESHOLD_MINUTES)
    if (ended > 0) logger.info(`[SESSION_CLEANUP] Auto-ended ${ended} session(s)`)
  } catch (err) {
    logger.error(
      "[SESSION_CLEANUP] Cleanup run failed:",
      (err as Error).message,
    )
  }
}

export function startStaleSessionCleanup(): void {
  if (cleanupTimer) {
    logger.warn("[SESSION_CLEANUP] Already running — ignoring duplicate start")
    return
  }

  // Run once immediately on boot to catch anything that went stale while
  // the server was down, then settle into the regular interval.
  void runStaleSessionCleanup()

  cleanupTimer = setInterval(() => {
    void runStaleSessionCleanup()
  }, CHECK_INTERVAL_MS)

  logger.info(
    `[SESSION_CLEANUP] Scheduled every ${CHECK_INTERVAL_MS / 60000}m ` +
      `(inactivity threshold: ${INACTIVITY_THRESHOLD_MINUTES}m)`,
  )
}

export function stopStaleSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}
