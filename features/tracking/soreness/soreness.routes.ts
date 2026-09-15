// Soreness: log an episode, check in on it, watch it recover.
//
// This is the old /api/tracking/soreness and /api/tracking/doms as one router —
// they were two halves of the same thing pointed at two tables.

import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import {
  queryLimit,
  parseIntParam,
  parseBackdatedTimestamp,
} from "@/middleware/validation.js"
import { NotFoundError, ValidationError } from "@/middleware/errorHandler.js"
import {
  logSoreness,
  getSorenessHistory,
  getActiveSoreness,
  getHistoryByMuscle,
  getSorenessStats,
  addFollowUp,
  batchFollowUp,
  deleteSorenessEntry,
} from "./soreness.model.js"

const router: Router = Router()

router.use(authenticateToken)

router.post("/", async (req: Request, res: Response) => {
  const { muscleGroup, intensity, loggedAt, note } = req.body
  const entry = await logSoreness(
    req.user!.id,
    muscleGroup,
    intensity,
    parseBackdatedTimestamp(loggedAt, "loggedAt"),
    note ?? null,
  )
  res.status(201).json({ success: true, data: entry })
})

router.get("/", async (req: Request, res: Response) => {
  const history = await getSorenessHistory(
    req.user!.id,
    queryLimit(req, { def: 100, max: 365 }),
  )
  res.json({ success: true, data: history })
})

// Static paths before the dynamic /:id ones.

router.get("/active", async (req: Request, res: Response) => {
  res.json({ success: true, data: await getActiveSoreness(req.user!.id) })
})

router.get("/stats", async (req: Request, res: Response) => {
  const days = queryLimit(req, { def: 30, max: 365, key: "days" })
  res.json({ success: true, data: await getSorenessStats(req.user!.id, days) })
})

router.get("/muscle/:muscle", async (req: Request, res: Response) => {
  const entries = await getHistoryByMuscle(
    req.user!.id,
    String(req.params.muscle),
    queryLimit(req, { def: 100, max: 365 }),
  )
  res.json({ success: true, data: entries })
})

/** Check in on many episodes at once — the "how is everything today" screen. */
router.post("/follow-ups", async (req: Request, res: Response) => {
  const { updates } = req.body
  if (!Array.isArray(updates))
    throw new ValidationError("updates must be an array")
  // The ids go straight into a bind list, so they get parsed here rather than
  // reaching mysql2 as undefined.
  const entries = await batchFollowUp(
    req.user!.id,
    updates.map((u) => ({
      ...u,
      sorenessId: parseIntParam(String(u?.sorenessId), "soreness entry ID"),
    })),
  )
  res.json({ success: true, data: entries })
})

/** Check in on one episode. The episode's own status follows the report. */
router.post("/:id/follow-ups", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "soreness entry ID")
  const { intensity, status, note } = req.body
  // note passes raw: absent leaves the episode note alone, null clears it
  const entry = await addFollowUp(req.user!.id, id, intensity, status, note)
  res.status(201).json({ success: true, data: entry })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "soreness entry ID")
  if (!(await deleteSorenessEntry(req.user!.id, id)))
    throw new NotFoundError("Soreness entry")
  res.json({ success: true })
})

export default router
