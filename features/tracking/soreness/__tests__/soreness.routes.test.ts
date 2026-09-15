import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

describe("soreness routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let entryId: number

  beforeAll(async () => {
    u = await signup("sore")
    const res = await request(app)
      .post("/api/tracking/soreness")
      .set(auth(u.token))
      .send({ muscleGroup: "chest", intensity: 6, note: "after bench" })
    expect(res.status).toBe(201)
    entryId = res.body.data.id
  })

  it("lists entries", async () => {
    const history = await request(app).get("/api/tracking/soreness").set(auth(u.token))
    expect(history.body.data.length).toBe(1)
    expect(history.body.data[0].muscleGroup).toBe("chest")
    expect(history.body.data[0].followUps).toEqual([])

    const active = await request(app).get("/api/tracking/soreness/active").set(auth(u.token))
    expect(active.body.data.length).toBe(1)
  })

  // The follow-up endpoints used to be a second feature (/api/tracking/doms)
  // over the same table; they are these two routes now.
  it("records follow-ups, singly and in a batch", async () => {
    const one = await request(app)
      .post(`/api/tracking/soreness/${entryId}/follow-ups`)
      .set(auth(u.token))
      .send({ intensity: 3, status: "better" })
    expect(one.status).toBe(201)

    const batch = await request(app)
      .post("/api/tracking/soreness/follow-ups")
      .set(auth(u.token))
      .send({ updates: [{ sorenessId: entryId, intensity: 0, status: "recovered" }] })
    expect(batch.status).toBe(200)

    const bad = await request(app)
      .post(`/api/tracking/soreness/${entryId}/follow-ups`)
      .set(auth(u.token))
      .send({ intensity: 11, status: "better" })
    expect(bad.status).toBe(400)

    const history = await request(app).get("/api/tracking/soreness").set(auth(u.token))
    expect(history.body.data[0].followUps.length).toBe(2)
    expect(history.body.data[0].status).toBe("recovered")
    expect(history.body.data[0].recoveredAt).toBeTruthy()
  })

  it("deletes entries", async () => {
    const del = await request(app).delete(`/api/tracking/soreness/${entryId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/soreness/${entryId}`).set(auth(u.token))
    expect(again.status).toBe(404)
  })
})
