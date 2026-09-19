import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

describe("workout lifecycle", () => {
  let a: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    a = await signup("wolife")
  })

  it("ends once and ignores a replayed end", async () => {
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 1, dayTitle: "Push", split: "push" })
    const id = start.body.session.id

    const first = await request(app)
      .post(`/api/sessions/${id}/end`)
      .set(auth(a.token))
      .send({})
    expect(first.status).toBe(200)
    expect(first.body.alreadyEnded).toBe(false)

    // The replay a client makes after a week offline: it must not rewrite
    // end_time and turn a short workout into a multi-day one.
    const replay = await request(app)
      .post(`/api/sessions/${id}/end`)
      .set(auth(a.token))
      .send({ endTime: new Date(Date.now() + 6 * 86400_000).toISOString() })
    expect(replay.status).toBe(200)
    expect(replay.body.alreadyEnded).toBe(true)
    expect(replay.body.session.endTime).toBe(first.body.session.endTime)
    expect(replay.body.session.totalDuration).toBe(
      first.body.session.totalDuration,
    )

    // A set posted after the end is a conflict the client can reconcile, not a
    // silent append into a finished workout.
    const late = await request(app)
      .post(`/api/sessions/${id}/set`)
      .set(auth(a.token))
      .send({
        exerciseName: "Bench Press",
        setIndex: 0,
        startTime: "2024-02-01T09:00:00Z",
        endTime: "2024-02-01T09:00:30Z",
        weight: 60,
        reps: 8,
      })
    expect(late.status).toBe(409)
    expect(late.body.code).toBe("SESSION_ALREADY_ENDED")
  })

  it("rejects an end before the workout started", async () => {
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 2, dayTitle: "Pull", split: "pull" })
    const id = start.body.session.id

    const backwards = await request(app)
      .post(`/api/sessions/${id}/end`)
      .set(auth(a.token))
      .send({ endTime: "2020-01-01T00:00:00Z" })
    expect(backwards.status).toBe(400)

    await request(app).post(`/api/sessions/${id}/end`).set(auth(a.token)).send({})
  })
})
