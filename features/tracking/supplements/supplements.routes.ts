import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { queryLimit } from "@/middleware/validation.js"
import {
  ValidationError,
  NotFoundError,
} from "@/middleware/errorHandler.js"
import {
  createSupplement,
  getSupplementById,
  listSupplementSummaries,
  updateSupplement,
  deleteSupplement,
  logSupplement,
  hasTakenTodayServer,
  getHistory,
  getStreak,
  deleteLogEntry,
} from "./supplements.model.js"

const router: Router = Router()
router.use(authenticateToken)

const VALID_TIME = /^\d{1,2}:\d{2}$/
const VALID_HEX_COLOR = /^#[0-9A-Fa-f]{6}$/

function validateReminderTime(t: unknown): void {
  if (t != null && (typeof t !== "string" || !VALID_TIME.test(t))) {
    throw new ValidationError("reminderTime must be in HH:MM format")
  }
}

function validateColor(c: unknown): void {
  if (c != null && (typeof c !== "string" || !VALID_HEX_COLOR.test(c))) {
    throw new ValidationError("color must be a hex color string (e.g. #FF5733)")
  }
}

function parseSupplementId(raw: string): number {
  const id = parseInt(raw, 10)
  if (isNaN(id)) throw new ValidationError("Invalid supplement id")
  return id
}

async function requireSupplement(userId: number, supplementId: number) {
  const s = await getSupplementById(userId, supplementId)
  if (!s) throw new NotFoundError("Supplement")
  return s
}

router.get("/", async (req: Request, res: Response) => {
  const summaries = await listSupplementSummaries(req.user!.id)
  res.json({ success: true, supplements: summaries })
})

router.post("/", async (req: Request, res: Response) => {
  const {
    name,
    unit = "g",
    defaultAmount,
    reminderEnabled = false,
    reminderTime = null,
    color = null,
    icon = null,
  } = req.body

  if (!name || typeof name !== "string" || !name.trim()) {
    throw new ValidationError("name is required")
  }
  if (name.trim().length > 100) {
    throw new ValidationError("name must be 100 characters or fewer")
  }
  if (typeof unit !== "string" || !unit.trim() || unit.length > 30) {
    throw new ValidationError(
      "unit must be a non-empty string (max 30 chars)",
    )
  }
  if (
    defaultAmount !== undefined &&
    (typeof defaultAmount !== "number" ||
      defaultAmount <= 0 ||
      defaultAmount > 10000)
  ) {
    throw new ValidationError(
      "defaultAmount must be a positive number (max 10000)",
    )
  }
  validateReminderTime(reminderTime)
  validateColor(color)

  const supplement = await createSupplement(
    req.user!.id,
    name.trim(),
    unit.trim(),
    defaultAmount ?? 5,
    reminderEnabled,
    reminderTime,
    color,
    icon ?? null,
  )

  res.status(201).json({ success: true, supplement })
})

router.patch("/:id", async (req: Request, res: Response) => {
  const supplementId = parseSupplementId(String(req.params.id))
  await requireSupplement(req.user!.id, supplementId)

  const {
    name,
    unit,
    defaultAmount,
    reminderEnabled,
    reminderTime,
    color,
    icon,
  } = req.body

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim())
      throw new ValidationError("name must be a non-empty string")
    if (name.trim().length > 100)
      throw new ValidationError("name must be 100 characters or fewer")
  }
  if (
    unit !== undefined &&
    (typeof unit !== "string" || !unit.trim() || unit.length > 30)
  ) {
    throw new ValidationError(
      "unit must be a non-empty string (max 30 chars)",
    )
  }
  if (
    defaultAmount !== undefined &&
    (typeof defaultAmount !== "number" ||
      defaultAmount <= 0 ||
      defaultAmount > 10000)
  ) {
    throw new ValidationError(
      "defaultAmount must be a positive number (max 10000)",
    )
  }
  validateReminderTime(reminderTime)
  validateColor(color)

  const updated = await updateSupplement(req.user!.id, supplementId, {
    name: name?.trim(),
    unit: unit?.trim(),
    defaultAmount,
    reminderEnabled,
    reminderTime,
    color,
    icon,
  })

  res.json({ success: true, supplement: updated })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const supplementId = parseSupplementId(String(req.params.id))
  const deleted = await deleteSupplement(req.user!.id, supplementId)
  if (!deleted) throw new NotFoundError("Supplement")
  res.json({ success: true })
})

router.post("/:id/log", async (req: Request, res: Response) => {
  const supplementId = parseSupplementId(String(req.params.id))
  const supplement = await requireSupplement(req.user!.id, supplementId)
  const { amount, takenAt, note } = req.body

  if (
    amount !== undefined &&
    (typeof amount !== "number" || amount <= 0 || amount > 10000)
  ) {
    throw new ValidationError("amount must be a positive number (max 10000)")
  }

  const entryId = await logSupplement(
    req.user!.id,
    supplementId,
    amount ?? supplement.defaultAmount,
    takenAt ?? null,
    note ?? null,
  )
  const streak = await getStreak(req.user!.id, supplementId)

  res.status(201).json({ success: true, id: entryId, streak })
})

router.get("/:id/log", async (req: Request, res: Response) => {
  const supplementId = parseSupplementId(String(req.params.id))
  await requireSupplement(req.user!.id, supplementId)

  const limit = queryLimit(req, { def: 30, max: 365 })
  const [entries, streak, todayEntry] = await Promise.all([
    getHistory(req.user!.id, supplementId, limit),
    getStreak(req.user!.id, supplementId),
    hasTakenTodayServer(req.user!.id, supplementId),
  ])

  res.json({
    success: true,
    entries,
    streak,
    takenToday: !!todayEntry,
    todayEntry,
  })
})

router.delete("/:id/log/:entryId", async (req: Request, res: Response) => {
  const supplementId = parseSupplementId(String(req.params.id))
  await requireSupplement(req.user!.id, supplementId)

  const entryId = parseInt(String(req.params.entryId), 10)
  if (isNaN(entryId)) throw new ValidationError("Invalid entry id")

  const deleted = await deleteLogEntry(req.user!.id, entryId)
  if (!deleted) throw new NotFoundError("Log entry")
  res.json({ success: true })
})

export default router
