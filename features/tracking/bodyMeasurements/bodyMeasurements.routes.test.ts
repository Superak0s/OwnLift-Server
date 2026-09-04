import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

describe("bodyMeasurements routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let entryId: number

  beforeAll(async () => {
    u = await signup("bmeas")
    const empty = await request(app).post("/api/tracking/measurements").set(auth(u.token)).send({})
    expect(empty.status).toBe(400)

    const res = await request(app)
      .post("/api/tracking/measurements")
      .set(auth(u.token))
      .send({ waistCm: 81, armLeftCm: 34, note: "monday" })
    expect(res.status).toBe(201)
    entryId = res.body.id
  })

  it("lists and deletes entries", async () => {
    const history = await request(app).get("/api/tracking/measurements").set(auth(u.token))
    expect(history.body.data.length).toBe(1)
    expect(history.body.data[0].waistCm).toBe(81)

    const del = await request(app).delete(`/api/tracking/measurements/${entryId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/measurements/${entryId}`).set(auth(u.token))
    expect(again.status).toBe(400)
  })
})
