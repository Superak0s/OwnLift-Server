import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

describe("personalNotes routes", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("pnote")
  })

  it("creates notes and reads them per muscle", async () => {
    const ok = await request(app)
      .post("/api/tracking/personal-notes")
      .set(auth(u.token))
      .send({ muscleGroup: "chest", content: "keep elbows tucked" })
    expect(ok.status).toBe(201)

    const chest = await request(app).get("/api/tracking/personal-notes/muscle/chest").set(auth(u.token))
    expect(chest.body.data.length).toBe(1)
    expect(chest.body.data[0].content).toBe("keep elbows tucked")

    const legs = await request(app).get("/api/tracking/personal-notes/muscle/legs").set(auth(u.token))
    expect(legs.body.data.length).toBe(0)
  })
})
