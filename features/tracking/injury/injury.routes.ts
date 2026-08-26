import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import {
  ValidationError,
} from "@/middleware/errorHandler.js"
import {
  logInjury,
  getAllInjuries,
  getInjuriesByMuscle,
  getActiveInjuries,
} from "./injury.model.js"

const router: Router = Router()

router.use(authenticateToken)

router.post("/", async (req: Request, res: Response) => {
  const { muscleGroup, injuryType, painLevel, startDate, notes } = req.body

  if (!muscleGroup || !injuryType || painLevel === undefined || painLevel === null) {
    throw new ValidationError("Muscle group, injury type, and pain level are required")
  }

  const result = await logInjury(
    req.user!.id,
    muscleGroup,
    injuryType,
    painLevel,
    startDate || new Date().toISOString(),
    notes || null,
  )
  res.status(201).json({ success: true, data: result })
})

router.get("/", async (req: Request, res: Response) => {
  const injuries = await getAllInjuries(req.user!.id)
  res.json({ success: true, data: injuries })
})

router.get("/muscle/:muscle", async (req: Request, res: Response) => {
  const muscle = String(req.params.muscle)
  const injuries = await getInjuriesByMuscle(req.user!.id, muscle)
  res.json({ success: true, data: injuries })
})

router.get("/active", async (req: Request, res: Response) => {
  const injuries = await getActiveInjuries(req.user!.id)
  res.json({ success: true, data: injuries })
})

export default router
