// routes/reminders.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../middleware/auth"
import {
  asyncHandler,
  ValidationError,
} from "../middleware/errorHandler"
import {
  createOrUpdateReminder,
  getReminder,
  getAllReminders,
  getEnabledReminders,
  toggleReminder,
  deleteReminder,
  type ReminderType,
} from "../models/reminders"

const router: Router = Router()

router.use(authenticateToken)

// ─── Create or update reminder ────────────────────────────────────────────────

router.post(
  "/reminders",
  asyncHandler(async (req: Request, res: Response) => {
    const {
      reminderType,
      enabled,
      frequency,
      timeOfDay,
      dayOfWeek,
    } = req.body

    if (!reminderType) {
      throw new ValidationError("Reminder type is required")
    }

    const id = await createOrUpdateReminder(
      req.user!.id,
      reminderType as ReminderType,
      enabled !== false, // Default to true
      frequency || "daily",
      timeOfDay || null,
      dayOfWeek !== undefined ? dayOfWeek : null,
    )

    res.status(200).json({ success: true, id })
  }),
)

// ─── Get all reminders ────────────────────────────────────────────────────────

router.get(
  "/reminders",
  asyncHandler(async (req: Request, res: Response) => {
    const reminders = await getAllReminders(req.user!.id)
    res.json({ success: true, data: reminders })
  }),
)

// ─── Get enabled reminders only ───────────────────────────────────────────────

router.get(
  "/reminders/enabled",
  asyncHandler(async (req: Request, res: Response) => {
    const reminders = await getEnabledReminders(req.user!.id)
    res.json({ success: true, data: reminders })
  }),
)

// ─── Get specific reminder ────────────────────────────────────────────────────

router.get(
  "/reminders/:reminderType",
  asyncHandler(async (req: Request, res: Response) => {
    const { reminderType } = req.params
    const reminder = await getReminder(req.user!.id, reminderType as ReminderType)
    if (!reminder) {
      return res.json({
        success: true,
        data: null,
        message: "Reminder not found",
      })
    }
    res.json({ success: true, data: reminder })
  }),
)

// ─── Toggle reminder enabled/disabled ─────────────────────────────────────────

router.patch(
  "/reminders/:reminderType/toggle",
  asyncHandler(async (req: Request, res: Response) => {
    const { reminderType } = req.params
    const { enabled } = req.body

    if (enabled === undefined) {
      throw new ValidationError("enabled parameter is required")
    }

    const updated = await toggleReminder(
      req.user!.id,
      reminderType as ReminderType,
      enabled,
    )
    if (!updated) throw new ValidationError("Reminder not found")
    res.json({ success: true })
  }),
)

// ─── Delete reminder ──────────────────────────────────────────────────────────

router.delete(
  "/reminders/:reminderType",
  asyncHandler(async (req: Request, res: Response) => {
    const { reminderType } = req.params
    const deleted = await deleteReminder(
      req.user!.id,
      reminderType as ReminderType,
    )
    if (!deleted) throw new ValidationError("Reminder not found")
    res.json({ success: true })
  }),
)

export default router
