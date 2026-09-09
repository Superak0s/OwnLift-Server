import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

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

  it("lists entries and settings", async () => {
    const history = await request(app).get("/api/tracking/hydration").set(auth(u.token))
    expect(history.body.data.length).toBe(1)
    expect(history.body.data[0].amountMl).toBe(500)

    const settings = await request(app).get("/api/tracking/hydration/settings").set(auth(u.token))
    expect(settings.status).toBe(200)
  })

  it("updates settings with validation", async () => {
    const bad = await request(app)
      .post("/api/tracking/hydration/settings")
      .set(auth(u.token))
      .send({ goalMl: -5 })
    expect(bad.status).toBe(400)

    const ok = await request(app)
      .post("/api/tracking/hydration/settings")
      .set(auth(u.token))
      .send({ goalMl: 2500, measurementErrorPercent: 5 })
    expect(ok.status).toBe(200)

    const read = await request(app).get("/api/tracking/hydration/settings").set(auth(u.token))
    expect(read.body.data.goalMl).toBe(2500)
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
