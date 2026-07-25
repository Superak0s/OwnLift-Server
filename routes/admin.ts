// routes/admin.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../middleware/auth.js"
import { asyncHandler } from "../middleware/errorHandler.js"
import { clearAdminSessions } from "../models/workout.js"

const router: Router = Router()

router.post(
  "/clear",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const clearedCount: number = await clearAdminSessions(userId)

    res.json({
      success: true,
      message: `Cleared ${clearedCount} admin session(s)`,
      clearedCount,
    })
  }),
)

export default router
