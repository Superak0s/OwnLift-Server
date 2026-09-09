// Run with: npx tsx middleware/validation.check.ts
import assert from "node:assert/strict"
import type { Request } from "express"
import {
  queryLimit,
  parseIntParam,
  validateSetTiming,
  validateRequired,
  parseBackdatedTimestamp,
} from "./validation.js"

const req = (query: Record<string, string>) => ({ query }) as unknown as Request

// queryLimit: absent / unparseable / zero all fall back to the default.
assert.equal(queryLimit(req({}), { def: 30, max: 365 }), 30)
assert.equal(queryLimit(req({ limit: "abc" }), { def: 30, max: 365 }), 30)
assert.equal(queryLimit(req({ limit: "0" }), { def: 30, max: 365 }), 30)
// ...a sane value passes through, and an oversized one is clamped.
assert.equal(queryLimit(req({ limit: "50" }), { def: 30, max: 365 }), 50)
assert.equal(queryLimit(req({ limit: "99999" }), { def: 30, max: 365 }), 365)
// ...and a non-default query key is honoured.
assert.equal(queryLimit(req({ days: "7" }), { def: 30, max: 365, key: "days" }), 7)

// parseIntParam: ids are auto-increment, so only >= 1 is valid.
assert.equal(parseIntParam("42", "photo ID"), 42)
for (const bad of ["0", "-1", "abc", ""]) {
  assert.throws(
    () => parseIntParam(bad, "photo ID"),
    /Invalid photo ID/,
    `expected ${JSON.stringify(bad)} to be rejected`,
  )
}

// parseBackdatedTimestamp: absent means "use now", a past local stamp passes
// through untouched, and only a wildly-future one is rejected — same-day slack
// covers a phone ahead of a UTC-running server.
assert.equal(parseBackdatedTimestamp(undefined, "loggedAt"), null)
assert.equal(parseBackdatedTimestamp(null, "loggedAt"), null)
assert.equal(
  parseBackdatedTimestamp("2020-08-24T09:00:00", "loggedAt"),
  "2020-08-24T09:00:00",
)
const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
assert.equal(parseBackdatedTimestamp(inTwoHours, "loggedAt"), inTwoHours)
for (const bad of ["", "not-a-date", 12345]) {
  assert.throws(
    () => parseBackdatedTimestamp(bad, "loggedAt"),
    /loggedAt must be an ISO-8601 date/,
    `expected ${JSON.stringify(bad)} to be rejected`,
  )
}
assert.throws(
  () => parseBackdatedTimestamp("2126-01-01T09:00:00Z", "loggedAt"),
  /loggedAt cannot be in the future/,
)

console.log("validation helpers ok")

// validateSetTiming is shared by the create and the partial-update path: it
// checks any field that IS present and stays silent about absent ones, with
// the create route running validateRequired ahead of it.
const mw = (body: Record<string, unknown>) => () =>
  validateSetTiming({ body } as unknown as Request, {} as never, () => {})

const good = {
  exerciseName: "Bench",
  setIndex: 0,
  startTime: "2026-01-01T10:00:00Z",
  endTime: "2026-01-01T10:00:40Z",
}
mw(good)() // full create payload passes
mw({ weight: 60 })() // a lone field passes — that's the update path
mw({ machineName: "Machine A" })() // free text, only the length cap applies
mw({ machineName: null })() // null is "no machine", same as absent
mw({ rpe: 1 })(); mw({ rpe: 10 })() // rpe is an integer on a 1-10 scale
mw({ rpe: null })() // null clears a rating — never coerced to 0
mw({})() // empty patch passes

// ...but a supplied field that is malformed is still rejected on both paths.
for (const [bad, re] of [
  [{ exerciseName: "  " }, /non-empty string/],
  [{ primaryMuscles: "Chest" }, /primaryMuscles/],
  [{ secondaryMuscles: [1] }, /secondaryMuscles/],
  [{ setIndex: -1 }, /non-negative integer/],
  [{ startTime: "not-a-date" }, /start time/],
  [{ weight: -5 }, /positive number/],
  [{ reps: 0 }, /positive integer/],
  [{ isWarmup: "yes" }, /isWarmup/],
  [{ machineName: 7 }, /machineName must be a string/],
  [{ machineName: "x".repeat(101) }, /machineName/],
  [{ rpe: 0 }, /rpe must be an integer between 1 and 10/],
  [{ rpe: 11 }, /rpe/],
  [{ rpe: 7.5 }, /rpe/],
  [{ rpe: "8" }, /rpe/],
] as [Record<string, unknown>, RegExp][]) {
  assert.throws(mw(bad), /Invalid set timing data/, `expected ${JSON.stringify(bad)} to be rejected`)
  const err = (() => { try { mw(bad)() } catch (e) { return e } })() as { details: string[] }
  assert.ok(err.details.some((d) => re.test(d)), `expected a ${re} message, got ${JSON.stringify(err.details)}`)
}

// validateRequired is what makes the create path demand the mandatory fields —
// and setIndex 0 must survive it, since 0 is a legitimate first set.
const req2 = (body: Record<string, unknown>) => ({ body }) as unknown as Request
assert.throws(
  () => validateRequired(["exerciseName", "setIndex"])(req2({ exerciseName: "Bench" }), {} as never, () => {}),
  /Missing required fields: setIndex/,
)
validateRequired(["setIndex"])(req2({ setIndex: 0 }), {} as never, () => {})

console.log("set timing validation ok")
