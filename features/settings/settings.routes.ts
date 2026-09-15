import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { ValidationError } from "@/middleware/errorHandler.js"
import {
  getUserSettings,
  updateUserSettings,
  SETTING_KEYS,
  type SettingKey,
} from "./settings.model.js"

const router: Router = Router()

router.use(authenticateToken)

router.get("/", async (req: Request, res: Response) => {
  const settings = await getUserSettings(req.user!.id)
  res.json({ success: true, data: settings })
})

/**
 * PATCH with any subset of the setting keys. Anything not sent keeps its current
 * value, so the hydration screen and the macros screen can each write only what
 * they own without reading the whole object first.
 */
router.patch("/", async (req: Request, res: Response) => {
  const patch: Partial<Record<SettingKey, number>> = {}

  for (const key of SETTING_KEYS) {
    const value = req.body[key]
    if (value == null) continue
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new ValidationError(`${key} must be a number >= 0`)
    patch[key] = value
  }

  // The CHECK constraints in schema.sql are the real range rules; this only
  // rejects a body that would have changed nothing.
  if (Object.keys(patch).length === 0)
    throw new ValidationError("No known settings in request body")

  await updateUserSettings(req.user!.id, patch)
  const settings = await getUserSettings(req.user!.id)
  res.json({ success: true, data: settings })
})

export default router
