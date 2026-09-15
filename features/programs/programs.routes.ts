import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { applyTrainerContext, denyTrainer } from "@/middleware/trainerContext.js"
import {
  NotFoundError,
  ValidationError,
} from "@/middleware/errorHandler.js"
import {
  getProgramByUserId,
  upsertProgram,
  deleteProgramByUserId,
  renameExercise,
  addExercise,
  patchExerciseSets,
  patchExerciseMachine,
  MACHINE_FIELDS,
} from "./programs.model.js"

const router: Router = Router()

router.use(authenticateToken, applyTrainerContext)

router.get("/", async (req: Request, res: Response) => {
  const result = await getProgramByUserId(req.user!.id)
  if (!result) throw new NotFoundError("Program")

  const { programData, originalFilename, uploadedAt } = result
  res.json({
    success: true,
    originalFilename,
    uploadedAt,
    totalDays: programData.days.length,
    split: programData.split,
    days: programData.days,
  })
})

/**
 * POST /api/program/upload
 *
 * The client now parses the workout file itself (utils/clientWorkoutParser.tsx)
 * and sends the already-parsed WorkoutData as JSON. This route just validates
 * shape and persists it — no file handling on the server anymore. Size is
 * capped by the 2 MB express.json parser mounted on this path in server.ts.
 */
// denyTrainer: upsertProgram replaces the caller's whole program rather than
// merging into it, so without this a trainer could post an empty weeklyPlan
// with X-Trainee-Id and erase the trainee's program outright. There is no
// versioning to recover it from.
router.post("/upload", denyTrainer, async (req: Request, res: Response) => {
  const { weeklyPlan, originalFilename } = req.body

  if (
    !weeklyPlan ||
    !Array.isArray(weeklyPlan.days) ||
    !Array.isArray(weeklyPlan.split)
  ) {
    throw new ValidationError(
      "weeklyPlan with days[] and split[] is required",
    )
  }

  if (!originalFilename || typeof originalFilename !== "string") {
    throw new ValidationError("originalFilename is required")
  }

  await upsertProgram(req.user!.id, weeklyPlan, originalFilename)

  res.json({
    success: true,
    totalDays: weeklyPlan.days.length,
    split: weeklyPlan.split,
    days: weeklyPlan.days,
  })
})

router.delete("/", denyTrainer, async (req: Request, res: Response) => {
  await deleteProgramByUserId(req.user!.id)
  res.json({ success: true, message: "Program deleted" })
})

router.patch("/exercise/rename", async (req: Request, res: Response) => {
  const {
    dayNumber,
    exerciseIndex,
    newName,
    newPrimaryMuscles,
    newSecondaryMuscles,
  } = req.body
  const split = req.body.split

  if (
    dayNumber == null ||
    !split ||
    exerciseIndex == null ||
    !newName?.trim()
  ) {
    throw new ValidationError(
      "dayNumber, split, exerciseIndex, and newName are required",
    )
  }

  const result = await renameExercise(
    req.user!.id,
    dayNumber,
    split,
    exerciseIndex,
    newName,
    newPrimaryMuscles,
    newSecondaryMuscles,
    // absent leaves the stored id alone; explicit null clears it
    "newExerciseId" in req.body ? req.body.newExerciseId : undefined,
  )

  res.json({
    success: true,
    message: `Renamed "${result.oldName}" → "${result.newName}"`,
    exerciseIndex: result.exerciseIndex,
  })
})

router.patch("/exercise/add", async (req: Request, res: Response) => {
  const { dayNumber, exercise } = req.body
  const split = req.body.split

  if (dayNumber == null || !split || !exercise?.name || !exercise?.sets) {
    throw new ValidationError(
      "dayNumber, split, and exercise (name + sets) are required",
    )
  }

  const result = await addExercise(req.user!.id, dayNumber, split, exercise)

  res.json({
    success: true,
    message: `Added exercise "${result.exercise.name}" at index ${result.exerciseIndex}`,
    exerciseIndex: result.exerciseIndex,
    exercise: result.exercise,
  })
})

router.patch("/exercise/sets", async (req: Request, res: Response) => {
  const { dayNumber, exerciseIndex, additionalSets } = req.body
  const split = req.body.split

  if (
    dayNumber == null ||
    !split ||
    exerciseIndex == null ||
    !additionalSets
  ) {
    throw new ValidationError(
      "dayNumber, split, exerciseIndex, and additionalSets are required",
    )
  }

  const result = await patchExerciseSets(
    req.user!.id,
    dayNumber,
    split,
    exerciseIndex,
    additionalSets,
  )

  res.json({
    success: true,
    message: `Added ${additionalSets} sets to exercise at index ${result.exerciseIndex}`,
    newSetCount: result.newSetCount,
  })
})

// Deliberately NOT denyTrainer: this is the granular alternative to
// /upload for the one program edit trainer mode actually performs. It
// rewrites five machine keys on one exercise rather than replacing the whole
// program, so a trainer working from a stale copy can't clobber the trainee.
router.patch("/exercise/machine", async (req: Request, res: Response) => {
  const { dayNumber, exerciseIndex, patch } = req.body
  const split = req.body.split

  if (dayNumber == null || !split || exerciseIndex == null || !patch) {
    throw new ValidationError(
      "dayNumber, split, exerciseIndex, and patch are required",
    )
  }
  const unknown = Object.keys(patch).filter(
    (k) => !(MACHINE_FIELDS as readonly string[]).includes(k),
  )
  if (unknown.length)
    throw new ValidationError(
      `patch may only contain ${MACHINE_FIELDS.join(", ")}; got ${unknown.join(", ")}`,
    )

  const result = await patchExerciseMachine(
    req.user!.id,
    dayNumber,
    split,
    exerciseIndex,
    patch,
  )

  res.json({ success: true, exerciseIndex: result.exerciseIndex })
})

export default router
