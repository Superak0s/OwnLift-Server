import { describe, it, expect } from "vitest"
import { normalizeProgram } from "../programs.model.js"
import type { ProgramData } from "../programs.types.js"

const raw = {
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
} as unknown as ProgramData

describe("normalizeProgram", () => {
  it("defaults a missing exerciseId to null and keeps a supplied one", () => {
    const p = normalizeProgram(raw)
    const [unmatched, matched] = p.days[0].exercises

    expect(unmatched.exerciseId).toBe(null)
    expect(matched.setsBySplit).toEqual({ PPL: 3 })
    expect(matched.exerciseId).toBe("Cable_Fly")
    expect(p.days[0].split.PPL.exercises[0].exerciseId).toBe(null)
    expect(p.days[0].split.PPL.exercises[1].exerciseId).toBe("Cable_Fly")
  })

  it("round-trips unknown per-exercise keys through the JSON column verbatim", () => {
    const p = normalizeProgram(raw)
    const roundTripped = normalizeProgram(
      JSON.parse(JSON.stringify(p)) as ProgramData,
    )

    expect(roundTripped.days[0].split.PPL.exercises[1]).toEqual(
      p.days[0].split.PPL.exercises[1],
    )
  })
})
