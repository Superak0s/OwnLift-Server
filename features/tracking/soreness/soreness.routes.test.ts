import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

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
    entryId = res.body.id
  })

  it("lists and deletes entries", async () => {
    const history = await request(app).get("/api/tracking/soreness").set(auth(u.token))
    expect(history.body.data.length).toBe(1)
    expect(history.body.data[0].muscleGroup).toBe("chest")

    const del = await request(app).delete(`/api/tracking/soreness/${entryId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/soreness/${entryId}`).set(auth(u.token))
    expect(again.status).toBe(404)
  })
})
