// routes/health.ts
import { Router, Request, Response } from "express"
import { pool } from "../config/database.js"
import { authenticateToken } from "../middleware/auth.js"
import { asyncHandler } from "../middleware/errorHandler.js"
import { getAnalytics } from "../models/analytics.js"

const router: Router = Router()

/**
 * GET /api/health
 * Requires authentication. Returns server status + per-user stats.
 * Global counts (totalUsers, totalSessions) are only shown to authenticated users
 * to avoid leaking business metrics publicly.
 */
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const [[sessionCount], [adminCount], [userCount]] = await Promise.all([
      pool.execute<any[]>(
        "SELECT COUNT(*) as count FROM sessions WHERE is_admin = 0",
      ),
      pool.execute<any[]>(
        "SELECT COUNT(*) as count FROM sessions WHERE is_admin = 1",
      ),
      pool.execute<any[]>("SELECT COUNT(*) as count FROM users"),
    ])

    const userAnalytics = await getAnalytics(req.user!.id)

    res.json({
      status: "OK",
      message: "Workout tracker server is running",
      database: "Connected",
      timestamp: new Date().toISOString(),
      globalStats: {
        totalSessions: sessionCount[0].count,
        totalAdminSessions: adminCount[0].count,
        totalUsers: userCount[0].count,
      },
      userStats: {
        username: req.user!.username,
        averageTimeBetweenSets: userAnalytics.avg_time_between_sets || 120,
        totalSessions: userAnalytics.total_sessions || 0,
        totalSetsCompleted: userAnalytics.total_sets || 0,
      },
    })
  }),
)

export default router
