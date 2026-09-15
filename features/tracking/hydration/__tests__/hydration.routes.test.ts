import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

describe("hydration routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let entryId: number

  beforeAll(async () => {
    u = await signup("hydr")
    const res = await request(app)
      .post("/api/tracking/hydration")
      .set(auth(u.token))
      .send({ amountMl: 500, note: "morning" })
    expect(res.status).toBe(201)
    entryId = res.body.id
  })

  it("lists entries", async () => {
    const history = await request(app).get("/api/tracking/hydration").set(auth(u.token))
    expect(history.body.data.length).toBe(1)
    expect(history.body.data[0].value).toBe(500)
  })

  // The hydration goal lives in /api/settings with every other preference now.
  it("updates hydration settings with validation", async () => {
    const bad = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ hydrationGoalMl: -5 })
    expect(bad.status).toBe(400)

    const zero = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ hydrationGoalMl: 0 })
    expect(zero.status).toBe(400)

    const ok = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ hydrationGoalMl: 2500, hydrationErrorPercent: 5 })
    expect(ok.status).toBe(200)
    expect(ok.body.data.hydrationGoalMl).toBe(2500)

    const read = await request(app).get("/api/settings").set(auth(u.token))
    expect(read.body.data.hydrationGoalMl).toBe(2500)
  })

  it("deletes entries, 404 on a missing one", async () => {
    const del = await request(app).delete(`/api/tracking/hydration/${entryId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/hydration/${entryId}`).set(auth(u.token))
    expect(again.status).toBe(404)

    const badId = await request(app).delete("/api/tracking/hydration/abc").set(auth(u.token))
    expect(badId.status).toBe(400)
  })
})
