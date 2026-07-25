// src/services/workoutService.ts
import { pool } from "../config/database.js"
import { ValidationError } from "../middleware/errorHandler.js"
import { getUserProgram, getPersonWorkoutPlan } from "../models/workout/program.js"
import type {
  ProgramData,
  Exercise,
  DifficultyResult,
  RecommendationEntry,
  ExerciseValidationResult,
  WorkoutSplit,
} from "../types/index.js"

export type {
  DifficultyResult,
  RecommendationEntry,
  ExerciseValidationResult,
  WorkoutSplit,
}

// Maximum number of recommendations returned in a single response.
const MAX_RECOMMENDATIONS = 10

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateProgramStructure(programData: ProgramData): void {
  if (!Array.isArray(programData.days) || programData.days.length === 0)
    throw new ValidationError("Program must have at least one day")
  if (!Array.isArray(programData.split))
    throw new ValidationError("Program must have a split array")

  for (const day of programData.days) {
    if (!day.dayNumber || !day.dayTitle)
      throw new ValidationError("Each day must have dayNumber and dayTitle")
    if (!day.split || typeof day.split !== "object")
      throw new ValidationError("Each day must have a split object")

    for (const [person, data] of Object.entries(day.split)) {
      if (!Array.isArray(data.exercises))
        throw new ValidationError(
          `Day ${day.dayNumber} - ${person}: exercises must be an array`,
        )
      for (const ex of data.exercises) {
        if (!ex.name || !ex.sets)
          throw new ValidationError(
            `Day ${day.dayNumber} - ${person}: each exercise must have name and sets`,
          )
      }
    }
  }
}

// ─── Plan generation ──────────────────────────────────────────────────────────

export async function generatePersonWorkoutPlan(
  userId: number,
  personName: string,
) {
  const plan = await getPersonWorkoutPlan(userId, personName)
  const totalSets = plan.days.reduce((s, d) => s + d.totalSets, 0)
  const totalExercises = plan.days.reduce((s, d) => s + d.exercises.length, 0)
  const muscleGroups = Array.from(
    new Set(plan.days.flatMap((d) => d.muscleGroups)),
  )
  return { ...plan, totalSets, totalExercises, muscleGroups }
}

// ─── Recommendations ──────────────────────────────────────────────────────────

export async function getWorkoutRecommendations(
  userId: number,
  personName: string,
): Promise<{ recommendations: RecommendationEntry[] }> {
  const program = await getUserProgram(userId)
  if (!program) return { recommendations: [] }

  const [dayFrequency] = await pool.execute<any[]>(
    `SELECT day_number, COUNT(*) AS session_count, MAX(start_time) AS last_session
     FROM sessions WHERE user_id = ? AND person = ? AND is_admin = 0
     GROUP BY day_number ORDER BY session_count DESC`,
    [userId, personName],
  )

  const programDays = program.programData.days
  const trainedDays = (dayFrequency as Array<{ day_number: number }>).map(
    (d) => d.day_number,
  )
  const untrainedDays = programDays
    .map((d) => d.dayNumber)
    .filter((n) => !trainedDays.includes(n))

  const recommendations: RecommendationEntry[] = []

  // Highest priority: days the user has never trained.
  if (untrainedDays.length > 0) {
    const dayData = programDays.find((d) => d.dayNumber === untrainedDays[0])
    if (dayData) {
      recommendations.push({
        type: "untrained_day",
        priority: "high",
        message: `You haven't trained ${dayData.dayTitle} yet`,
        dayNumber: untrainedDays[0],
        dayTitle: dayData.dayTitle,
      })
    }
  }

  // Medium priority: days last trained more than 7 days ago.
  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 7)

  for (const day of dayFrequency as Array<{
    day_number: number
    last_session: string
  }>) {
    if (recommendations.length >= MAX_RECOMMENDATIONS) break
    if (new Date(day.last_session) < weekAgo) {
      const dayData = programDays.find((d) => d.dayNumber === day.day_number)
      if (dayData) {
        recommendations.push({
          type: "overdue",
          priority: "medium",
          message: `It's been a while since you trained ${dayData.dayTitle}`,
          dayNumber: day.day_number,
          dayTitle: dayData.dayTitle,
          daysSince: Math.floor(
            (Date.now() - new Date(day.last_session).getTime()) / 86_400_000,
          ),
        })
      }
    }
  }

  return { recommendations }
}

// ─── Difficulty & comparison ──────────────────────────────────────────────────

export function calculateProgramDifficulty(
  programData: ProgramData,
): DifficultyResult {
  let totalSets = 0
  let totalExercises = 0
  const daysPerWeek = programData.days.length

  for (const day of programData.days) {
    for (const data of Object.values(day.split)) {
      totalSets += data.totalSets || 0
      totalExercises += data.exercises.length
    }
  }

  // Guard against division by zero when a program has no days.
  const setsPerDay = daysPerWeek > 0 ? totalSets / daysPerWeek : 0
  const exercisesPerDay = daysPerWeek > 0 ? totalExercises / daysPerWeek : 0

  const difficulty =
    setsPerDay > 25 || exercisesPerDay > 8
      ? "advanced"
      : setsPerDay > 15 || exercisesPerDay > 5
        ? "intermediate"
        : "beginner"

  return {
    difficulty,
    totalSets,
    totalExercises,
    daysPerWeek,
    setsPerDay: Math.round(setsPerDay),
    exercisesPerDay: Math.round(exercisesPerDay),
  }
}

export function comparePrograms(p1: ProgramData, p2: ProgramData) {
  const d1 = calculateProgramDifficulty(p1)
  const d2 = calculateProgramDifficulty(p2)
  return {
    program1: d1,
    program2: d2,
    comparison: {
      setsDifference: d2.totalSets - d1.totalSets,
      exercisesDifference: d2.totalExercises - d1.totalExercises,
      daysDifference: d2.daysPerWeek - d1.daysPerWeek,
    },
  }
}

// ─── Split recommendation ─────────────────────────────────────────────────────

export function recommendWorkoutSplit(daysPerWeek: number): WorkoutSplit {
  const splits: Record<number, WorkoutSplit> = {
    3: {
      name: "Push/Pull/Legs",
      days: [
        { name: "Push", muscleGroups: ["Chest", "Shoulders", "Triceps"] },
        { name: "Pull", muscleGroups: ["Back", "Biceps"] },
        {
          name: "Legs",
          muscleGroups: ["Quads", "Hamstrings", "Calves", "Glutes"],
        },
      ],
    },
    4: {
      name: "Upper/Lower Split",
      days: [
        { name: "Upper A", muscleGroups: ["Chest", "Back", "Shoulders"] },
        { name: "Lower A", muscleGroups: ["Quads", "Hamstrings", "Calves"] },
        { name: "Upper B", muscleGroups: ["Chest", "Back", "Arms"] },
        { name: "Lower B", muscleGroups: ["Quads", "Hamstrings", "Glutes"] },
      ],
    },
    5: {
      name: "Bro Split",
      days: [
        { name: "Chest", muscleGroups: ["Chest", "Triceps"] },
        { name: "Back", muscleGroups: ["Back", "Biceps"] },
        { name: "Shoulders", muscleGroups: ["Shoulders", "Traps"] },
        { name: "Legs", muscleGroups: ["Quads", "Hamstrings", "Calves"] },
        { name: "Arms", muscleGroups: ["Biceps", "Triceps", "Forearms"] },
      ],
    },
    6: {
      name: "Push/Pull/Legs x2",
      days: [
        { name: "Push A", muscleGroups: ["Chest", "Shoulders", "Triceps"] },
        { name: "Pull A", muscleGroups: ["Back", "Biceps"] },
        { name: "Legs A", muscleGroups: ["Quads", "Hamstrings", "Calves"] },
        { name: "Push B", muscleGroups: ["Chest", "Shoulders", "Triceps"] },
        { name: "Pull B", muscleGroups: ["Back", "Biceps"] },
        { name: "Legs B", muscleGroups: ["Quads", "Hamstrings", "Glutes"] },
      ],
    },
  }
  // Default to 3-day PPL for any unsupported day count.
  return splits[daysPerWeek] ?? splits[3]
}

// ─── Exercise validation ──────────────────────────────────────────────────────

export function validateExerciseProgression(
  exercises: Exercise[],
): ExerciseValidationResult {
  const warnings: ExerciseValidationResult["warnings"] = []
  const COMPOUND_KEYWORDS = [
    "squat",
    "deadlift",
    "bench",
    "press",
    "row",
    "pull",
  ]
  const first = exercises[0]?.name.toLowerCase() ?? ""

  if (
    !COMPOUND_KEYWORDS.some((kw) => first.includes(kw)) &&
    exercises.length > 1
  ) {
    warnings.push({
      type: "exercise_order",
      message: "Consider starting with a compound exercise",
      recommendation:
        "Move compound exercises (squats, deadlifts, bench press) to the beginning",
    })
  }

  const groupCounts = exercises
    .map((e) => e.muscleGroup)
    .filter(Boolean)
    .reduce<Record<string, number>>((acc, g) => {
      acc[g!] = (acc[g!] || 0) + 1
      return acc
    }, {})

  const counts = Object.values(groupCounts)
  if (counts.length > 0 && Math.max(...counts) > Math.min(...counts) * 2) {
    warnings.push({
      type: "muscle_imbalance",
      message: "Muscle group imbalance detected",
      recommendation: "Balance exercises across muscle groups",
    })
  }

  return { isValid: warnings.length === 0, warnings }
}
