// Run with: npx tsx --env-file-if-exists=.env features/programs/programs.normalize.check.ts
import assert from "node:assert/strict"
import { normalizeProgram } from "./programs.model.js"
import type { ProgramData } from "./programs.types.js"

const p = normalizeProgram({
  split: ["PPL"],
  days: [
    {
      dayNumber: 1,
      dayTitle: "Push",
      muscleGroups: ["chest"],
      exercises: [
        { name: "Bench", muscleGroup: "chest", setsBySplit: { PPL: 4 } },
        {
          name: "Fly",
          muscleGroup: "chest",
          exerciseId: "Cable_Fly",
          setsBySplit: { PPL: 3 },
        },
      ],
      split: {
        PPL: {
          exercises: [
            { name: "Bench", muscleGroup: "chest", sets: 4 },
            {
              name: "Fly",
              muscleGroup: "chest",
              sets: 3,
              exerciseId: "Cable_Fly",
            },
          ],
          totalSets: 7,
        },
      },
    },
  ],
} as unknown as ProgramData)

const [unmatched, matched] = p.days[0].exercises
assert.equal(unmatched.exerciseId, null)
assert.deepEqual(matched.setsBySplit, { PPL: 3 })
assert.equal(matched.exerciseId, "Cable_Fly")
assert.equal(p.days[0].split.PPL.exercises[0].exerciseId, null)
assert.equal(p.days[0].split.PPL.exercises[1].exerciseId, "Cable_Fly")
console.log("normalizeProgram ok")
