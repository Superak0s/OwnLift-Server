// routes/workouts.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../middleware/auth.js"
import {
  asyncHandler,
  ForbiddenError,
  ValidationError,
} from "../middleware/errorHandler.js"
import {
  validateSessionCreation,
  validateSetTiming,
  validateSetTimingUpdate,
  validateRequired,
} from "../middleware/validation.js"
import { pool } from "../config/database.js"
import { notifyWatcher, pushSessionStatus } from "../ws/wsServer.js"
import {
  createSession,
  recordSetTiming,
  updateSetTiming,
  renameExerciseInHistory,
  endSession,
  getSessionDetails,
  getSessionHistory,
  clearAdminSessions,
  deleteAllSessionsForPerson,
  updateSessionPerson,
} from "../models/workout.js"
import { getFriendSessionDetails } from "../models/social/sharing.js"

const router: Router = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a route/query param as a positive integer. Returns null on failure. */
function parseId(value: string | undefined): number | null {
  if (!value) return null
  const n = parseInt(value, 10)
  return isNaN(n) || n < 1 ? null : n
}

/** Verify the session exists and belongs to the caller. Returns the row or throws. */
async function requireOwnSession(
  sessionId: number,
  userId: number,
): Promise<{ id: number; is_admin: number }> {
  const [rows] = await pool.execute<any[]>(
    "SELECT id, is_admin FROM sessions WHERE id = ? AND user_id = ?",
    [sessionId, userId],
  )
  if (rows.length === 0)
    throw new ForbiddenError("Session not found or unauthorized")
  return rows[0]
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/sessions
 */
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const { person, dayNumber, limit, includeTimings } = req.query

    const sessions = await getSessionHistory(
      userId,
      (person as string) || null,
      dayNumber ? parseInt(dayNumber as string, 10) : null,
      limit ? parseInt(limit as string, 10) : 30,
      includeTimings === "true",
    )

    res.json({ success: true, sessions, total: sessions.length })
  }),
)

/**
 * POST /api/sessions/start
 */
router.post(
  "/start",
  authenticateToken,
  validateSessionCreation,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const { person, dayNumber, dayTitle, muscleGroups, isAdmin } = req.body

    const newSessionId: number = await createSession(
      userId,
      dayNumber,
      dayTitle,
      muscleGroups,
      isAdmin || false,
      req.body.startTime || null,
    )

    if (person) {
      await updateSessionPerson(newSessionId, userId, person)
    }

    const session = await getSessionDetails(newSessionId, userId)

    if (!isAdmin) {
      pushSessionStatusToWatchers(
        userId,
        req.user!.username,
        newSessionId,
        "friend_session_started",
      )
    }

    res.json({ success: true, session: { ...session, id: newSessionId } })
  }),
)

/**
 * POST /api/sessions/rename-exercise
 *
 * Rename / re-group an exercise everywhere it appears in a person's session
 * history. Static path — declared before the dynamic /:sessionId routes.
 */
router.post(
  "/rename-exercise",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const { person, oldName, newName, muscleGroup } = req.body

    if (!person || typeof oldName !== "string" || !oldName.trim()) {
      throw new ValidationError("person and oldName are required")
    }

    const updatedCount = await renameExerciseInHistory(
      userId,
      person,
      oldName.trim(),
      newName,
      muscleGroup,
    )
    res.json({ success: true, updatedCount })
  }),
)

/**
 * POST /api/sessions/:sessionId/set
 */
router.post(
  "/:sessionId/set",
  authenticateToken,
  validateSetTiming,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const sessionId = parseId(req.params.sessionId)
    if (sessionId === null) throw new ValidationError("Invalid session ID")

    const {
      exerciseName,
      setIndex,
      startTime,
      endTime,
      weight,
      reps,
      note,
      isWarmup,
      muscleGroup,
    } = req.body

    if (
      !exerciseName ||
      typeof exerciseName !== "string" ||
      !exerciseName.trim()
    ) {
      throw new ValidationError(
        "exerciseName is required and must be a non-empty string",
      )
    }

    await requireOwnSession(sessionId, userId)

    const timing = await recordSetTiming(
      sessionId,
      exerciseName.trim(),
      setIndex,
      startTime,
      endTime,
      weight || 0,
      reps || 0,
      note || null,
      isWarmup || false,
      muscleGroup || null,
    )

    pushLiveUpdateToWatchers(userId, sessionId).catch((err: Error) =>
      console.warn("[WS] live update push failed:", err.message),
    )

    res.json({ success: true, timing })
  }),
)

/**
 * PATCH /api/sessions/:sessionId/sets/:setId
 *
 * Edit a previously recorded set (weight, reps, timestamps, exercise, etc.).
 */
router.patch(
  "/:sessionId/sets/:setId",
  authenticateToken,
  validateSetTimingUpdate,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const sessionId = parseId(req.params.sessionId)
    const setId = parseId(req.params.setId)
    if (sessionId === null || setId === null) {
      throw new ValidationError("Invalid session or set ID")
    }

    const timing = await updateSetTiming(sessionId, setId, userId, req.body)
    res.json({ success: true, timing })
  }),
)

/**
 * POST /api/sessions/:sessionId/end
 */
router.post(
  "/:sessionId/end",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const sessionId = parseId(req.params.sessionId)
    if (sessionId === null) throw new ValidationError("Invalid session ID")

    const row = await requireOwnSession(sessionId, userId)
    const session = await endSession(sessionId, req.body.endTime || null)

    if (!row.is_admin) {
      pushSessionStatusToWatchers(
        userId,
        req.user!.username,
        null,
        "friend_session_ended",
      )
    }

    res.json({ success: true, session })
  }),
)

/**
 * GET /api/sessions/:sessionId
 */
router.get(
  "/:sessionId",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const sessionId = parseId(req.params.sessionId)
    if (sessionId === null) throw new ValidationError("Invalid session ID")

    const session = await getSessionDetails(sessionId, userId)
    res.json({ success: true, session })
  }),
)

// ─── Bulk delete routes ───────────────────────────────────────────────────────
// NOTE: Static paths (/admin, /person/:person, /) MUST come before the
// dynamic /:sessionId routes so Express doesn't treat "admin" as a session ID.

/**
 * DELETE /api/sessions/admin
 */
router.delete(
  "/admin",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const deletedCount: number = await clearAdminSessions(userId)

    res.json({
      success: true,
      message: `Deleted ${deletedCount} admin session(s)`,
      deletedCount,
    })
  }),
)

/**
 * DELETE /api/sessions/person/:person
 */
router.delete(
  "/person/:person",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const { person } = req.params

    const result = await deleteAllSessionsForPerson(userId, person)
    res.json(result)
  }),
)

/**
 * DELETE /api/sessions  (delete all non-admin sessions)
 */
router.delete(
  "/",
  authenticateToken,
  validateRequired(["confirmDelete"]),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const { confirmDelete } = req.body

    if (confirmDelete !== "DELETE_ALL_SESSIONS") {
      throw new ValidationError(
        'Must confirm deletion with confirmDelete: "DELETE_ALL_SESSIONS"',
      )
    }

    const [result] = await pool.execute<any>(
      "DELETE FROM sessions WHERE user_id = ? AND is_admin = 0",
      [userId],
    )

    res.json({
      success: true,
      message: `Deleted ${result.affectedRows} session(s)`,
      deletedCount: result.affectedRows,
    })
  }),
)

// ─── WS push helpers ──────────────────────────────────────────────────────────

async function pushSessionStatusToWatchers(
  userId: number,
  username: string,
  sessionId: number | null,
  type: string,
): Promise<void> {
  try {
    const [watchers] = await pool.execute<any[]>(
      `SELECT sp.to_user_id
       FROM sharing_permissions sp
       JOIN friendships f
         ON (  (f.user_id = sp.from_user_id AND f.friend_id = sp.to_user_id)
            OR (f.user_id = sp.to_user_id   AND f.friend_id = sp.from_user_id) )
       WHERE sp.from_user_id = ? AND sp.permission_type = 'watch_session'
         AND f.status = 'accepted'`,
      [userId],
    )

    watchers.forEach((w: { to_user_id: number }) => {
      pushSessionStatus(w.to_user_id, type, {
        friendId: userId,
        friendUsername: username,
        ...(sessionId != null && { sessionId }),
      })
    })
  } catch (err) {
    console.warn(
      "[WS] pushSessionStatusToWatchers failed:",
      (err as Error).message,
    )
  }
}

async function pushLiveUpdateToWatchers(
  userId: number,
  sessionId: number,
): Promise<void> {
  const [watchers] = await pool.execute<any[]>(
    `SELECT sp.to_user_id
     FROM sharing_permissions sp
     JOIN friendships f
       ON (  (f.user_id = sp.from_user_id AND f.friend_id = sp.to_user_id)
          OR (f.user_id = sp.to_user_id   AND f.friend_id = sp.from_user_id) )
     WHERE sp.from_user_id = ? AND sp.permission_type = 'watch_session'
       AND f.status = 'accepted'`,
    [userId],
  )

  if (!watchers.length) return

  const liveSession = await getFriendSessionDetails(userId, sessionId)
  if (!liveSession) return

  watchers.forEach((w: { to_user_id: number }) => {
    notifyWatcher(w.to_user_id, liveSession)
  })
}

export default router
