// routes/programs.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../middleware/auth.js"
import {
  asyncHandler,
  NotFoundError,
  ValidationError,
} from "../middleware/errorHandler.js"
import {
  getProgramByUserId,
  upsertProgram,
  deleteProgramByUserId,
  renameExercise,
  addExercise,
  patchExerciseSets,
} from "../models/workout/program.js"

const router: Router = Router()

router.use(authenticateToken)

// Guard against storing huge program blobs — 2 MB is generous for a spreadsheet
const MAX_PROGRAM_JSON_BYTES = 2 * 1024 * 1024

/**
 * GET /api/program
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
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
  }),
)

/**
 * POST /api/program/upload
 *
 * The client now parses the workout file itself (utils/clientWorkoutParser.tsx)
 * and sends the already-parsed WorkoutData as JSON. This route just validates
 * shape/size and persists it — no file handling on the server anymore.
 */
router.post(
  "/upload",
  asyncHandler(async (req: Request, res: Response) => {
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

    // Guard against bloated parsed output before persisting
    const serialised = JSON.stringify(weeklyPlan)
    if (Buffer.byteLength(serialised, "utf8") > MAX_PROGRAM_JSON_BYTES) {
      throw new ValidationError(
        `Parsed program exceeds the ${MAX_PROGRAM_JSON_BYTES / 1024} KB size limit`,
      )
    }

    await upsertProgram(req.user!.id, weeklyPlan, originalFilename)

    res.json({
      success: true,
      totalDays: weeklyPlan.days.length,
      split: weeklyPlan.split,
      days: weeklyPlan.days,
    })
  }),
)

/**
 * DELETE /api/program
 */
router.delete(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    await deleteProgramByUserId(req.user!.id)
    res.json({ success: true, message: "Program deleted" })
  }),
)

/**
 * PATCH /api/program/exercise/rename
 */
router.patch(
  "/exercise/rename",
  asyncHandler(async (req: Request, res: Response) => {
    const { dayNumber, person, exerciseIndex, newName, newMuscleGroup } =
      req.body

    if (
      dayNumber == null ||
      !person ||
      exerciseIndex == null ||
      !newName?.trim()
    ) {
      throw new ValidationError(
        "dayNumber, person, exerciseIndex, and newName are required",
      )
    }

    const result = await renameExercise(
      req.user!.id,
      dayNumber,
      person,
      exerciseIndex,
      newName,
      newMuscleGroup,
    )

    res.json({
      success: true,
      message: `Renamed "${result.oldName}" → "${result.newName}"`,
      exerciseIndex: result.exerciseIndex,
    })
  }),
)

/**
 * PATCH /api/program/exercise/add
 */
router.patch(
  "/exercise/add",
  asyncHandler(async (req: Request, res: Response) => {
    const { dayNumber, person, exercise } = req.body

    if (dayNumber == null || !person || !exercise?.name || !exercise?.sets) {
      throw new ValidationError(
        "dayNumber, person, and exercise (name + sets) are required",
      )
    }

    const result = await addExercise(req.user!.id, dayNumber, person, exercise)

    res.json({
      success: true,
      message: `Added exercise "${result.exercise.name}" at index ${result.exerciseIndex}`,
      exerciseIndex: result.exerciseIndex,
      exercise: result.exercise,
    })
  }),
)

/**
 * PATCH /api/program/exercise/sets
 */
router.patch(
  "/exercise/sets",
  asyncHandler(async (req: Request, res: Response) => {
    const { dayNumber, person, exerciseIndex, additionalSets } = req.body

    if (
      dayNumber == null ||
      !person ||
      exerciseIndex == null ||
      !additionalSets
    ) {
      throw new ValidationError(
        "dayNumber, person, exerciseIndex, and additionalSets are required",
      )
    }

    const result = await patchExerciseSets(
      req.user!.id,
      dayNumber,
      person,
      exerciseIndex,
      additionalSets,
    )

    res.json({
      success: true,
      message: `Added ${additionalSets} sets to exercise at index ${result.exerciseIndex}`,
      newSetCount: result.newSetCount,
    })
  }),
)

export default router
