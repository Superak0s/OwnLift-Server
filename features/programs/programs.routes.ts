import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { applyTrainerContext, denyTrainer } from "@/middleware/trainerContext.js"
import { ValidationError } from "@/middleware/errorHandler.js"
import {
  getProgramByUserId,
  upsertProgram,
  deleteProgramByUserId,
  getProgramCurrentDay,
  setProgramCurrentDay,
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
  // Not an error: every user has no program until they save one, and the client
  // reads this 404 as "none yet". Answered here rather than thrown so it never
  // reaches errorHandler's log.
  if (!result) {
    res.status(404).json({ success: false, error: "Program not found" })
    return
  }

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
 * The day pointer is a scalar the app syncs across devices, independent of the
 * program body — reading it does not require pulling the whole program back.
 * 200 with `null` rather than 404 when there is no program: "no day set" and
 * "no program" are the same fallback on the client.
 */
router.get("/current-day", async (req: Request, res: Response) => {
  res.json({
    success: true,
    currentDay: await getProgramCurrentDay(req.user!.id),
  })
})

router.put("/current-day", async (req: Request, res: Response) => {
  const { currentDay } = req.body
  // ck_pd_day allows day_number 0, but no client ever uploads one, so the
  // range check stays at >= 1. setProgramCurrentDay additionally proves the
  // day exists — the range alone let a pointer outlive the day it named.
  if (!Number.isInteger(currentDay) || currentDay < 1)
    throw new ValidationError("currentDay must be an integer >= 1")

  await setProgramCurrentDay(req.user!.id, currentDay)
  res.json({ success: true, currentDay })
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

// denyTrainer: a rename re-points the slot at a different `exercises` row and
// backfills that shared row's muscle groups, so it changes how the trainee's
// own history reads. Adding an exercise and adjusting set counts stay open to
// trainers — those are the coaching edits the grant exists for.
router.patch("/exercise/rename", denyTrainer, async (req: Request, res: Response) => {
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
    additionalSets == null
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
