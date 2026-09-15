import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

describe("injury routes", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("injur")
  })

  it("logs injuries with validation", async () => {
    const missing = await request(app).post("/api/tracking/injuries").set(auth(u.token)).send({})
    expect(missing.status).toBe(400)

    const ok = await request(app)
      .post("/api/tracking/injuries")
      .set(auth(u.token))
      .send({ muscleGroup: "shoulder", injuryType: "strain", painLevel: 3, notes: "pinch" })
    expect(ok.status).toBe(201)
    expect(ok.body.data.id).toBeGreaterThan(0)
  })

  it("lists all, active, and per-muscle", async () => {
    const all = await request(app).get("/api/tracking/injuries").set(auth(u.token))
    expect(all.body.data.length).toBe(1)

    const active = await request(app).get("/api/tracking/injuries/active").set(auth(u.token))
    expect(active.body.data.length).toBe(1)

    const byMuscle = await request(app).get("/api/tracking/injuries/muscle/shoulder").set(auth(u.token))
    expect(byMuscle.body.data.length).toBe(1)

    const other = await request(app).get("/api/tracking/injuries/muscle/legs").set(auth(u.token))
    expect(other.body.data.length).toBe(0)
  })
})
