import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

describe("customMeasurements routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let typeId: number

  beforeAll(async () => {
    u = await signup("cmeas")
  })

  it("creates types and logs values", async () => {
    const type = await request(app)
      .post("/api/tracking/custom-measurements/types")
      .set(auth(u.token))
      .send({ keyName: "grip_strength", label: "Grip Strength", unit: "kg" })
    expect(type.status).toBe(201)
    typeId = type.body.data.id

    const types = await request(app).get("/api/tracking/custom-measurements/types").set(auth(u.token))
    expect(types.body.data.length).toBe(1)

    const badType = await request(app)
      .post("/api/tracking/custom-measurements/values")
      .set(auth(u.token))
      .send({ typeId: "abc", value: 50 })
    expect(badType.status).toBe(400)

    const value = await request(app)
      .post("/api/tracking/custom-measurements/values")
      .set(auth(u.token))
      .send({ typeId, value: 52.5, note: "right hand" })
    expect(value.status).toBe(201)
    expect(value.body.id).toBeGreaterThan(0)
  })
})
