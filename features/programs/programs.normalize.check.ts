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
      primaryMuscles: ["chest"],
      secondaryMuscles: ["triceps"],
      exercises: [
        {
          name: "Bench",
          primaryMuscles: ["chest"],
          secondaryMuscles: [],
          setsBySplit: { PPL: 4 },
        },
        {
          name: "Fly",
          primaryMuscles: ["chest"],
          secondaryMuscles: ["triceps"],
          exerciseId: "Cable_Fly",
          setsBySplit: { PPL: 3 },
        },
      ],
      split: {
        PPL: {
          exercises: [
            {
              name: "Bench",
              primaryMuscles: ["chest"],
              secondaryMuscles: [],
              sets: 4,
            },
            {
              name: "Fly",
              primaryMuscles: ["chest"],
              secondaryMuscles: ["triceps"],
              sets: 3,
              exerciseId: "Cable_Fly",
              // The machine list is client-owned and unknown to the server;
              // it only has to survive a save/load round-trip untouched.
              machines: ["Machine A", "Smith"],
              selectedMachine: "Machine A",
              defaultMachine: "Smith",
              bestAcrossMachines: { "Machine A": 60 },
              machineMeta: { "Machine A": { note: "seat 4", pin: true } },
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

// Unknown per-exercise keys must round-trip through the JSON column verbatim.
const roundTripped = normalizeProgram(JSON.parse(JSON.stringify(p)) as ProgramData)
assert.deepEqual(
  roundTripped.days[0].split.PPL.exercises[1],
  p.days[0].split.PPL.exercises[1],
)
console.log("normalizeProgram ok")
