import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { queryLimit, parseIntParam } from "@/middleware/validation.js"
import {
  NotFoundError,
} from "@/middleware/errorHandler.js"
import {
  logSoreness,
  getSorenessHistory,
  deleteSorenessEntry,
} from "./soreness.model.js"

const router: Router = Router()

router.use(authenticateToken)

router.post("/", async (req: Request, res: Response) => {
  const { muscleGroup, intensity, loggedAt, note } = req.body
  const id = await logSoreness(
    req.user!.id,
    muscleGroup,
    intensity,
    loggedAt || null,
    note || null,
  )
  res.status(201).json({ success: true, id })
})

router.get("/", async (req: Request, res: Response) => {
  const limit = queryLimit(req, { def: 100, max: 365 })
  const history = await getSorenessHistory(req.user!.id, limit)
  res.json({ success: true, data: history })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "soreness entry ID")
  const deleted = await deleteSorenessEntry(req.user!.id, id)
  if (!deleted) throw new NotFoundError("Soreness entry")
  res.json({ success: true })
})

export default router
