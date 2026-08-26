import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { ValidationError } from "@/middleware/errorHandler.js"
import { getAnalytics } from "./analytics.model.js"

const router: Router = Router()

router.get("/", authenticateToken, async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { dayNumber } = req.query
  const split = req.query.split as string | undefined

  let parsedDayNumber: number | null = null
  if (dayNumber !== undefined) {
    parsedDayNumber = parseInt(dayNumber as string, 10)
    if (isNaN(parsedDayNumber) || parsedDayNumber < 1) {
      throw new ValidationError("dayNumber must be a positive integer")
    }
  }

  const analytics = await getAnalytics(userId, split || null, parsedDayNumber)

  res.json({
    success: true,
    totalSessions: analytics.total_sessions || 0,
    totalSetsCompleted: analytics.total_sets || 0,
    averageTimeBetweenSets: analytics.avg_time_between_sets || 120,
    totalVolume: Math.round(analytics.total_volume || 0),
    averageRestTime: Math.round(analytics.avg_rest_time || 0),
    averageSetDuration: Math.round(analytics.avg_set_duration || 0),
    firstSession: analytics.first_session,
    lastSession: analytics.last_session,
  })
})

export default router
