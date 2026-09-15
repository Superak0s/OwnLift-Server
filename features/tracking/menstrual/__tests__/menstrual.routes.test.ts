import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

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
    expect(res.body.data.symptoms).toEqual(["cramps"])
    entryId = res.body.data.id
  })

  it("lists history and stats", async () => {
    const history = await request(app).get("/api/tracking/menstrual").set(auth(u.token))
    expect(history.body.data.length).toBeGreaterThanOrEqual(1)

    const stats = await request(app).get("/api/tracking/menstrual/stats").set(auth(u.token))
    expect(stats.status).toBe(200)
  })

  it("closes a cycle with PATCH", async () => {
    const patched = await request(app)
      .patch(`/api/tracking/menstrual/${entryId}`)
      .set(auth(u.token))
      .send({ cycleEnd: "2024-05-05", symptoms: ["cramps", "fatigue"] })
    expect(patched.status).toBe(200)
    expect(patched.body.data.cycleEnd).toContain("2024-05-05")
    expect(patched.body.data.symptoms).toEqual(["cramps", "fatigue"])
  })

  // Period and cycle length are /api/settings keys now, not a menstrual route.
  it("updates cycle settings with validation", async () => {
    const bad = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ cyclePeriodDays: 0 })
    expect(bad.status).toBe(400)

    const tooLong = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ cyclePeriodDays: 40, cycleLengthDays: 28 })
    expect(tooLong.status).toBe(400)

    const ok = await request(app)
      .patch("/api/settings")
      .set(auth(u.token))
      .send({ cyclePeriodDays: 5, cycleLengthDays: 28 })
    expect(ok.status).toBe(200)
    expect(ok.body.data.cyclePeriodDays).toBe(5)
  })

  it("deletes entries", async () => {
    const del = await request(app).delete(`/api/tracking/menstrual/${entryId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/menstrual/${entryId}`).set(auth(u.token))
    expect(again.status).toBe(404)
  })
})
