import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { applyTrainerContext, denyTrainer } from "@/middleware/trainerContext.js"
import { ForbiddenError, ValidationError } from "@/middleware/errorHandler.js"
import {
  parseIntParam,
  validateRequired,
  validateSessionCreation,
  validateSetTiming,
} from "@/middleware/validation.js"
import { pool } from "@/config/database.js"
import { logger } from "@/utils/logger.js"
import { sendToUser } from "@/ws/wsServer.js"
import {
  createSession,
  recordSetTiming,
  updateSetTiming,
  renameExerciseInHistory,
  endSession,
  getSessionDetails,
  getSessionHistory,
  deleteAllSessionsForSplit,
  deleteDemoSessions,
  updateSessionSplit,
} from "./workouts.model.js"
import {
  getFriendSessionDetails,
  getActiveTrainers,
} from "../social/sharing/sharing.model.js"

const router: Router = Router()

router.use(authenticateToken, applyTrainerContext)

async function requireOwnSession(
  sessionId: number,
  userId: number,
): Promise<void> {
  const [rows] = await pool.execute<any[]>(
    "SELECT id FROM sessions WHERE id = ? AND user_id = ?",
    [sessionId, userId],
  )
  if (rows.length === 0)
    throw new ForbiddenError("Session not found or unauthorized")
}

router.get("/", async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { split, dayNumber, limit, includeTimings } = req.query

  const sessions = await getSessionHistory(
    userId,
    (split as string) || null,
    dayNumber ? parseInt(dayNumber as string, 10) : null,
    limit ? parseInt(limit as string, 10) : 30,
    includeTimings === "true",
  )

  res.json({ success: true, sessions, total: sessions.length })
})

router.post("/start", validateSessionCreation, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { dayNumber, dayTitle, primaryMuscles, secondaryMuscles } = req.body
  const split = req.body.split

  const newSessionId: number = await createSession(
    userId,
    dayNumber,
    dayTitle,
    primaryMuscles ?? [],
    secondaryMuscles ?? [],
    req.body.startTime || null,
    req.body.isDemo === true,
  )

  if (split) {
    await updateSessionSplit(newSessionId, userId, split)
  }

  const session = await getSessionDetails(newSessionId, userId)

  pushSessionStatusToWatchers(
    userId,
    req.user!.username,
    newSessionId,
    "friend_session_started",
  )

  if (req.trainer)
    pushTrainerEvent(req, newSessionId, "trainer_session_started")

  res.json({ success: true, session: { ...session, id: newSessionId } })
})

/**
 * POST /api/sessions/rename-exercise
 *
 * Rename / re-group an exercise everywhere it appears in a split's session
 * history. Static path — declared before the dynamic /:sessionId routes.
 */
router.post("/rename-exercise", async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { oldName, newName, primaryMuscles, secondaryMuscles } = req.body
  const split = req.body.split

  if (!split || typeof oldName !== "string" || !oldName.trim()) {
    throw new ValidationError("split and oldName are required")
  }

  const updatedCount = await renameExerciseInHistory(
    userId,
    split,
    oldName.trim(),
    newName,
    primaryMuscles,
    secondaryMuscles,
  )
  res.json({ success: true, updatedCount })
})

router.post("/:sessionId/set", validateRequired(["exerciseName", "setIndex", "startTime", "endTime"]), validateSetTiming, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const sessionId = parseIntParam(String(req.params.sessionId), "session ID")

  // exerciseName is already required by validateRequired and shape-checked
  // by validateSetTiming, both mounted on this route.
  const {
    exerciseName,
    setIndex,
    startTime,
    endTime,
    weight,
    reps,
    note,
    isWarmup,
    primaryMuscles,
    secondaryMuscles,
    machineName,
    rpe,
  } = req.body

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
    primaryMuscles ?? [],
    secondaryMuscles ?? [],
    machineName || null,
    // Unrated stays NULL — 0 is not a valid RPE and would read as a real rating.
    rpe ?? null,
  )

  pushLiveUpdateToWatchers(userId, sessionId).catch((err: Error) =>
    logger.warn("[WS] live update push failed:", err.message),
  )

  if (req.trainer) {
    // A trainer recorded the set — the trainee needs to know their data changed.
    sendToUser(userId, "trainer_set_recorded", trainerEventPayload(req, sessionId))
  } else {
    // The trainee recorded their own set — tell every trainer with an active grant.
    const trainers = await getActiveTrainers(userId)
    trainers.forEach((t) =>
      sendToUser(t.trainerId, "trainee_set_recorded", {
        traineeId: userId,
        trainerId: t.trainerId,
        trainerUsername: t.trainerUsername,
        sessionId,
      }),
    )
  }

  res.json({ success: true, timing })
})

router.patch("/:sessionId/sets/:setId", validateSetTiming, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const sessionId = parseIntParam(String(req.params.sessionId), "session ID")
  const setId = parseIntParam(String(req.params.setId), "set ID")

  const timing = await updateSetTiming(sessionId, setId, userId, req.body)

  if (req.trainer)
    sendToUser(userId, "trainer_set_recorded", trainerEventPayload(req, sessionId))

  res.json({ success: true, timing })
})

router.post("/:sessionId/end", async (req: Request, res: Response) => {
  const userId = req.user!.id
  const sessionId = parseIntParam(String(req.params.sessionId), "session ID")

  await requireOwnSession(sessionId, userId)
  const session = await endSession(sessionId, req.body.endTime || null)

  pushSessionStatusToWatchers(
    userId,
    req.user!.username,
    null,
    "friend_session_ended",
  )

  if (req.trainer)
    pushTrainerEvent(req, sessionId, "trainer_session_ended")

  res.json({ success: true, session })
})

router.get("/:sessionId", async (req: Request, res: Response) => {
  const userId = req.user!.id
  const sessionId = parseIntParam(String(req.params.sessionId), "session ID")

  const session = await getSessionDetails(sessionId, userId)
  res.json({ success: true, session })
})

// NOTE: Static paths (/split/:split, /) MUST come before the dynamic
// /:sessionId routes so Express doesn't treat the literal as a session ID.

router.delete("/demo", denyTrainer, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const deletedCount = await deleteDemoSessions(userId)
  res.json({ success: true, deletedCount })
})

router.delete("/split/:split", denyTrainer, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const split = String(req.params.split)

  const deletedCount = await deleteAllSessionsForSplit(userId, split)
  res.json({
    success: deletedCount > 0,
    deletedCount,
    message: deletedCount
      ? `Deleted ${deletedCount} session(s) for split: ${split}`
      : `No sessions found for split: ${split}`,
  })
})


// Trainer-mode WS events. req.user is the trainee (swapped by
// applyTrainerContext) and req.trainer is the acting trainer, so the payload
// carries both sides of the pair on every event.
function trainerEventPayload(req: Request, sessionId: number) {
  return {
    traineeId: req.user!.id,
    trainerId: req.trainer!.userId,
    trainerUsername: req.trainer!.username,
    sessionId,
  }
}

/** trainer_session_started / trainer_session_ended go to both sides. */
function pushTrainerEvent(req: Request, sessionId: number, type: string): void {
  const payload = trainerEventPayload(req, sessionId)
  sendToUser(req.user!.id, type, payload)
  sendToUser(req.trainer!.userId, type, payload)
}

async function getSessionWatchers(userId: number): Promise<{ to_user_id: number }[]> {
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
  return watchers
}

async function pushSessionStatusToWatchers(
  userId: number,
  username: string,
  sessionId: number | null,
  type: string,
): Promise<void> {
  try {
    const watchers = await getSessionWatchers(userId)

    watchers.forEach((w: { to_user_id: number }) => {
      sendToUser(w.to_user_id, type, {
        friendId: userId,
        friendUsername: username,
        ...(sessionId != null && { sessionId }),
      })
    })
  } catch (err) {
    logger.warn(
      "[WS] pushSessionStatusToWatchers failed:",
      (err as Error).message,
    )
  }
}

async function pushLiveUpdateToWatchers(
  userId: number,
  sessionId: number,
): Promise<void> {
  const watchers = await getSessionWatchers(userId)

  if (!watchers.length) return

  const liveSession = await getFriendSessionDetails(userId, sessionId)
  if (!liveSession) return

  watchers.forEach((w: { to_user_id: number }) => {
    sendToUser(w.to_user_id, "live_session_update", { liveSession })
  })
}

export default router
