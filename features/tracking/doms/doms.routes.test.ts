import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

describe("doms routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let sorenessId: number

  beforeAll(async () => {
    u = await signup("doms")
  })

  it("logs soreness with validation", async () => {
    const missing = await request(app).post("/api/tracking/doms/log").set(auth(u.token)).send({})
    expect(missing.status).toBe(400)

    const badIntensity = await request(app)
      .post("/api/tracking/doms/log")
      .set(auth(u.token))
      .send({ muscleGroup: "back", intensity: 11 })
    expect(badIntensity.status).toBe(400)

    const ok = await request(app)
      .post("/api/tracking/doms/log")
      .set(auth(u.token))
      .send({ muscleGroup: "back", intensity: 7, notes: "heavy row" })
    expect(ok.status).toBe(201)
    sorenessId = ok.body.data.id
    expect(ok.body.data.status).toBe("active")

    const duplicate = await request(app)
      .post("/api/tracking/doms/log")
      .set(auth(u.token))
      .send({ muscleGroup: "back", intensity: 5 })
    expect(duplicate.status).toBe(400)
  })

  it("lists active records and history", async () => {
    const active = await request(app).get("/api/tracking/doms/active").set(auth(u.token))
    expect(active.body.data.length).toBe(1)

    const history = await request(app).get("/api/tracking/doms/history/back").set(auth(u.token))
    expect(history.body.data.length).toBe(1)
  })

  it("applies follow-ups with validation", async () => {
    const noIntensity = await request(app)
      .put(`/api/tracking/doms/${sorenessId}/followup`)
      .set(auth(u.token))
      .send({ status: "better" })
    expect(noIntensity.status).toBe(400)

    const badStatus = await request(app)
      .put(`/api/tracking/doms/${sorenessId}/followup`)
      .set(auth(u.token))
      .send({ intensity: 5, status: "gone" })
    expect(badStatus.status).toBe(400)

    const ghost = await request(app)
      .put("/api/tracking/doms/999999/followup")
      .set(auth(u.token))
      .send({ intensity: 5, status: "better" })
    expect(ghost.status).toBe(404)

    const ok = await request(app)
      .put(`/api/tracking/doms/${sorenessId}/followup`)
      .set(auth(u.token))
      .send({ intensity: 4, status: "better" })
    expect(ok.status).toBe(200)
    expect(ok.body.data.status).toBe("recovering")
  })

  it("handles batch follow-ups", async () => {
    const empty = await request(app).post("/api/tracking/doms/batch-followup").set(auth(u.token)).send({})
    expect(empty.status).toBe(400)

    const batch = await request(app)
      .post("/api/tracking/doms/batch-followup")
      .set(auth(u.token))
      .send({
        updates: [
          { sorenessId, intensity: 0, status: "recovered", notes: "all good" },
          { sorenessId: 999999, intensity: 0, status: "recovered" },
        ],
      })
    expect(batch.status).toBe(200)
    expect(batch.body.data.length).toBe(1)
    expect(batch.body.data[0].status).toBe("recovered")
  })

  it("computes stats", async () => {
    const stats = await request(app).get("/api/tracking/doms/stats?days=30").set(auth(u.token))
    expect(stats.status).toBe(200)
    expect(stats.body.data.totalRecoveryEpisodes).toBe(1)
  })
})
