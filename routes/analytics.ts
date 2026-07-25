// routes/analytics.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../middleware/auth.js"
import { asyncHandler, ValidationError } from "../middleware/errorHandler.js"
import { getComprehensiveAnalytics } from "../services/analyticsService.js"

const router: Router = Router()

/**
 * GET /api/analytics
 *
 * Uses analyticsService (instead of calling the model directly) so that
 * response shaping and default-zero coalescing live in one place.
 */
router.get(
  "/",
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id
    const { person, dayNumber } = req.query

    let parsedDayNumber: number | null = null
    if (dayNumber !== undefined) {
      parsedDayNumber = parseInt(dayNumber as string, 10)
      if (isNaN(parsedDayNumber) || parsedDayNumber < 1) {
        throw new ValidationError("dayNumber must be a positive integer")
      }
    }

    console.log(
      `[GET /api/analytics] User ${userId}, person: ${person || "all"}, day: ${parsedDayNumber ?? "all"}`,
    )

    const analytics = await getComprehensiveAnalytics(
      userId,
      (person as string) || null,
      parsedDayNumber,
    )

    res.json({ success: true, ...analytics })
  }),
)

export default router
