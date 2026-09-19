import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { applyTrainerContext } from "@/middleware/trainerContext.js"
import { parseIntParam, queryLimit } from "@/middleware/validation.js"
import { getAnalytics } from "./analytics.model.js"

const router: Router = Router()

router.get("/", authenticateToken, applyTrainerContext, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { dayNumber } = req.query
  const split = req.query.split as string | undefined

  const parsedDayNumber =
    dayNumber === undefined
      ? null
      : parseIntParam(String(dayNumber), "dayNumber")

  // The client picks its own lookback window. Without one this used to scan
  // the user's entire history on every dashboard open; 365 covers the default
  // dashboard and older app builds that send no ?days=. Ceiling is 10 years,
  // which is "all time" for any real user: the aggregated columns (weight,
  // reps) are in no index, so a wider window means a clustered-index lookup
  // per set row and multi-second waits on a small box.
  const days = queryLimit(req, { def: 365, max: 3650, key: "days" })

  const analytics = await getAnalytics(
    userId,
    split || null,
    parsedDayNumber,
    days,
  )

  res.json({
    success: true,
    totalSessions: analytics.total_sessions || 0,
    totalSetsCompleted: analytics.total_sets || 0,
    totalVolume: Math.round(analytics.total_volume || 0),
    firstSession: analytics.first_session,
    lastSession: analytics.last_session,
  })
})

export default router
