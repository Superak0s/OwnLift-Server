// measurements owns every scalar body metric — the pivot, the grouped delete
// and the user-defined-metric registry — and had no tests at all. These cover
// the parts nothing else in the suite reaches: the group read/delete, the
// ownership predicate on a second user's row, and the out-of-range value that
// used to reach the client as a 500.

import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

const BASE = "/api/tracking/measurements"

describe("measurements routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let other: Awaited<ReturnType<typeof signup>>
  let groupId: number

  beforeAll(async () => {
    u = await signup("meas")
    other = await signup("meas2")

    const res = await request(app)
      .post(BASE)
      .set(auth(u.token))
      .send({
        values: { waist_cm: 84, chest_cm: 102 },
        measuredAt: "2026-01-05T09:00:00.000Z",
        note: "morning",
      })
    expect(res.status).toBe(201)
    groupId = res.body.id
  })

  it("pivots one measuring session into a values map", async () => {
    const res = await request(app)
      .get(`${BASE}?metrics=waist_cm,chest_cm`)
      .set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].values).toEqual({ waist_cm: 84, chest_cm: 102 })
    expect(res.body.data[0].note).toBe("morning")
  })

  it("serves one metric as a plain series", async () => {
    const res = await request(app)
      .get(`${BASE}/waist_cm/history`)
      .set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.data[0].value).toBe(84)
  })

  it("rejects a metric the caller has not defined", async () => {
    const unknown = await request(app)
      .get(`${BASE}/not_a_metric/history`)
      .set(auth(u.token))
    expect(unknown.status).toBe(400)

    const unspellable = await request(app)
      .post(BASE)
      .set(auth(u.token))
      .send({ values: { "waist cm": 84 } })
    expect(unspellable.status).toBe(400)
  })

  it("answers 400, not 500, for a value the column cannot hold", async () => {
    // measurements.value is DECIMAL(10,3); 1e9 overflows it. The driver raises
    // ER_WARN_DATA_OUT_OF_RANGE, which used to fall through to a generic 500.
    const res = await request(app)
      .post(BASE)
      .set(auth(u.token))
      .send({ values: { waist_cm: 1e9 } })
    expect(res.status).toBe(400)
  })

  it("overwrites rather than doubling a metric replayed at the same instant", async () => {
    // Two devices coming back from a week offline both replay the same day.
    const at = "2026-02-02T08:00:00.000Z"
    for (const kg of [80, 81]) {
      const res = await request(app)
        .post(BASE)
        .set(auth(u.token))
        .send({ values: { weight_kg: kg }, measuredAt: at })
      expect(res.status).toBe(201)
    }

    // This user logs weight_kg nowhere else, so the whole series is that day.
    const history = await request(app)
      .get(`${BASE}/weight_kg/history`)
      .set(auth(u.token))
    expect(history.body.data).toHaveLength(1)
    expect(history.body.data[0].value).toBe(81)
  })

  it("registers and uses a user-defined metric", async () => {
    const def = await request(app)
      .post(`${BASE}/definitions`)
      .set(auth(u.token))
      .send({ keyName: "grip_kg", label: "Grip strength", unit: "kg" })
    expect(def.status).toBe(201)

    const dupe = await request(app)
      .post(`${BASE}/definitions`)
      .set(auth(u.token))
      .send({ keyName: "grip_kg", label: "Grip strength" })
    expect(dupe.status).toBe(409)

    const log = await request(app)
      .post(BASE)
      .set(auth(u.token))
      .send({ values: { grip_kg: 52 } })
    expect(log.status).toBe(201)

    // The definition is per-user, so the other account cannot log against it.
    const trespass = await request(app)
      .post(BASE)
      .set(auth(other.token))
      .send({ values: { grip_kg: 52 } })
    expect(trespass.status).toBe(400)
  })

  it("scopes every :id operation to the owner", async () => {
    const theirs = await request(app)
      .delete(`${BASE}/${groupId}`)
      .set(auth(other.token))
    expect(theirs.status).toBe(404)

    // ...and the row is still there for its actual owner.
    const still = await request(app)
      .get(`${BASE}?metrics=waist_cm`)
      .set(auth(u.token))
    expect(still.body.data).toHaveLength(1)
  })

  it("deletes the whole measuring session when ?metrics= is given", async () => {
    const del = await request(app)
      .delete(`${BASE}/${groupId}?metrics=waist_cm,chest_cm`)
      .set(auth(u.token))
    expect(del.status).toBe(200)

    const left = await request(app)
      .get(`${BASE}?metrics=waist_cm,chest_cm`)
      .set(auth(u.token))
    expect(left.body.data).toHaveLength(0)

    const again = await request(app)
      .delete(`${BASE}/${groupId}`)
      .set(auth(u.token))
    expect(again.status).toBe(404)
  })
})
