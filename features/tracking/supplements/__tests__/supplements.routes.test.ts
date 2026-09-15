import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"

describe("supplements routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let supplementId: number

  beforeAll(async () => {
    u = await signup("supp")
  })

  it("creates supplements with validation", async () => {
    const noName = await request(app).post("/api/tracking/supplements").set(auth(u.token)).send({})
    expect(noName.status).toBe(400)

    const badTime = await request(app)
      .post("/api/tracking/supplements")
      .set(auth(u.token))
      .send({ name: "Vitamin D", reminderTime: "9am" })
    expect(badTime.status).toBe(400)

    const badColor = await request(app)
      .post("/api/tracking/supplements")
      .set(auth(u.token))
      .send({ name: "Vitamin D", color: "red" })
    expect(badColor.status).toBe(400)

    const ok = await request(app)
      .post("/api/tracking/supplements")
      .set(auth(u.token))
      .send({ name: "Vitamin D", unit: "IU", defaultAmount: 2000, color: "#FF5733" })
    expect(ok.status).toBe(201)
    supplementId = ok.body.supplement.id
  })

  it("lists and updates supplements", async () => {
    const list = await request(app).get("/api/tracking/supplements").set(auth(u.token))
    expect(list.body.supplements.length).toBe(1)

    const update = await request(app)
      .patch(`/api/tracking/supplements/${supplementId}`)
      .set(auth(u.token))
      .send({ name: "Vit D" })
    expect(update.status).toBe(200)
    expect(update.body.supplement.name).toBe("Vit D")

    const missing = await request(app).patch("/api/tracking/supplements/999999").set(auth(u.token)).send({})
    expect(missing.status).toBe(404)
  })

  it("logs doses, tracks streaks, and deletes", async () => {
    const badAmount = await request(app)
      .post(`/api/tracking/supplements/${supplementId}/log`)
      .set(auth(u.token))
      .send({ amount: -5 })
    expect(badAmount.status).toBe(400)

    const log = await request(app)
      .post(`/api/tracking/supplements/${supplementId}/log`)
      .set(auth(u.token))
      .send({ amount: 2000 })
    expect(log.status).toBe(201)
    const entryId = log.body.id
    expect(log.body.streak).toBeGreaterThanOrEqual(1)

    const history = await request(app)
      .get(`/api/tracking/supplements/${supplementId}/log`)
      .set(auth(u.token))
    expect(history.status).toBe(200)
    expect(history.body.entries.length).toBe(1)
    expect(history.body.takenToday).toBe(true)

    const delEntry = await request(app)
      .delete(`/api/tracking/supplements/${supplementId}/log/${entryId}`)
      .set(auth(u.token))
    expect(delEntry.status).toBe(200)

    const del = await request(app).delete(`/api/tracking/supplements/${supplementId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const again = await request(app).delete(`/api/tracking/supplements/${supplementId}`).set(auth(u.token))
    expect(again.status).toBe(404)
  })
})
