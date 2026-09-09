import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { queryLimit, parseIntParam } from "@/middleware/validation.js"
import {
  NotFoundError,
  ValidationError,
} from "@/middleware/errorHandler.js"
import {
  logHydration,
  getHydrationHistory,
  deleteHydrationEntry,
  getHydrationSettings,
  setHydrationSettings,
} from "./hydration.model.js"

const router: Router = Router()

router.use(authenticateToken)

router.post("/", async (req: Request, res: Response) => {
  const { amountMl, loggedAt, note } = req.body
  const id = await logHydration(
    req.user!.id,
    amountMl,
    loggedAt || null,
    note || null,
  )
  res.status(201).json({ success: true, id })
})

router.get("/", async (req: Request, res: Response) => {
  const limit = queryLimit(req, { def: 100, max: 365 })
  const history = await getHydrationHistory(req.user!.id, limit)
  res.json({ success: true, data: history })
})

router.get("/settings", async (req: Request, res: Response) => {
  const s = await getHydrationSettings(req.user!.id)
  res.json({ success: true, data: s })
})

router.post("/settings", async (req: Request, res: Response) => {
  const { goalMl, measurementErrorPercent } = req.body
  if (goalMl != null && (!Number.isInteger(goalMl) || goalMl <= 0)) {
    throw new ValidationError("goalMl must be a positive integer")
  }
  if (measurementErrorPercent != null && typeof measurementErrorPercent !== "number") {
    throw new ValidationError("measurementErrorPercent must be a number (percentage)")
  }
  await setHydrationSettings(req.user!.id, { goalMl, measurementErrorPercent })
  res.json({ success: true })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "hydration entry ID")
  const deleted = await deleteHydrationEntry(req.user!.id, id)
  if (!deleted) throw new NotFoundError("Hydration entry")
  res.json({ success: true })
})

export default router
