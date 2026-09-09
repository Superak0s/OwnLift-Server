import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

describe("menstrual routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let entryId: number

  beforeAll(async () => {
    u = await signup("mens")
    const missing = await request(app).post("/api/tracking/menstrual").set(auth(u.token)).send({})
    expect(missing.status).toBe(400)

    const res = await request(app)
      .post("/api/tracking/menstrual")
      .set(auth(u.token))
      .send({ cycleStart: "2024-05-01", symptoms: ["cramps"] })
    expect(res.status).toBe(201)
    entryId = res.body.id
  })

  it("lists history and stats", async () => {
    const history = await request(app).get("/api/tracking/menstrual").set(auth(u.token))
    expect(history.body.data.length).toBeGreaterThanOrEqual(1)

    const stats = await request(app).get("/api/tracking/menstrual/stats").set(auth(u.token))
    expect(stats.status).toBe(200)
  })

  it("updates settings with validation", async () => {
    const bad = await request(app)
      .post("/api/tracking/menstrual/settings")
      .set(auth(u.token))
      .send({ periodDays: 0 })
    expect(bad.status).toBe(400)

    const ok = await request(app)
      .post("/api/tracking/menstrual/settings")
      .set(auth(u.token))
      .send({ periodDays: 5, cycleLengthDays: 28 })
    expect(ok.status).toBe(200)
  })

  it("deletes entries", async () => {
    const del = await request(app).delete(`/api/tracking/menstrual/${entryId}`).set(auth(u.token))
    expect(del.status).toBe(200)
    expect(typeof del.body.removedPredictions).toBe("boolean")

    const again = await request(app).delete(`/api/tracking/menstrual/${entryId}`).set(auth(u.token))
    expect(again.status).toBe(404)
  })
})
