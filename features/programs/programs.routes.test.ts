import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../tests/helpers.js"

const weeklyPlan = {
  split: ["push"],
  days: [
    {
      dayNumber: 1,
      dayTitle: "Push Day",
      exercises: [
        { name: "Bench Press", primaryMuscles: ["chest"], secondaryMuscles: [], setsBySplit: { push: 3 } },
      ],
      split: {
        push: { exercises: [{ name: "Bench Press", sets: 3 }], totalSets: 3 },
      },
    },
  ],
}

describe("programs routes", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("prog")
  })

  it("GET / 404s before an upload", async () => {
    expect((await request(app).get("/api/program").set(auth(u.token))).status).toBe(404)
  })

  it("POST /upload rejects malformed bodies", async () => {
    const noPlan = await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({ originalFilename: "plan.csv" })
    expect(noPlan.status).toBe(400)

    const noFile = await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({ weeklyPlan })
    expect(noFile.status).toBe(400)
  })

  it("uploads, retrieves, edits exercises, and deletes", async () => {
    const upload = await request(app)
      .post("/api/program/upload")
      .set(auth(u.token))
      .send({ weeklyPlan, originalFilename: "plan.csv" })
    expect(upload.status).toBe(200)
    expect(upload.body.totalDays).toBe(1)

    const got = await request(app).get("/api/program").set(auth(u.token))
    expect(got.status).toBe(200)
    expect(got.body.originalFilename).toBe("plan.csv")
    expect(got.body.days[0].dayNumber).toBe(1)

    const renameBad = await request(app)
      .patch("/api/program/exercise/rename")
      .set(auth(u.token))
      .send({ split: "push", exerciseIndex: 0 })
    expect(renameBad.status).toBe(400)

    const rename = await request(app)
      .patch("/api/program/exercise/rename")
      .set(auth(u.token))
      .send({ dayNumber: 1, split: "push", exerciseIndex: 0, newName: "Bench" })
    expect(rename.status).toBe(200)

    const addBad = await request(app)
      .patch("/api/program/exercise/add")
      .set(auth(u.token))
      .send({ dayNumber: 1, split: "push", exercise: {} })
    expect(addBad.status).toBe(400)

    const add = await request(app)
      .patch("/api/program/exercise/add")
      .set(auth(u.token))
      .send({ dayNumber: 1, split: "push", exercise: { name: "Overhead Press", sets: 3 } })
    expect(add.status).toBe(200)
    expect(add.body.exercise.name).toBe("Overhead Press")

    const setsBad = await request(app)
      .patch("/api/program/exercise/sets")
      .set(auth(u.token))
      .send({ dayNumber: 1, split: "push", exerciseIndex: 0 })
    expect(setsBad.status).toBe(400)

    const sets = await request(app)
      .patch("/api/program/exercise/sets")
      .set(auth(u.token))
      .send({ dayNumber: 1, split: "push", exerciseIndex: 0, additionalSets: 2 })
    expect(sets.status).toBe(200)
    expect(sets.body.newSetCount).toBe(5)

    const del = await request(app).delete("/api/program").set(auth(u.token))
    expect(del.status).toBe(200)

    const gone = await request(app).get("/api/program").set(auth(u.token))
    expect(gone.status).toBe(404)
  })
})
