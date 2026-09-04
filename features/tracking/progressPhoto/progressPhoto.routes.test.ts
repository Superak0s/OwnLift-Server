import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

// 8-byte PNG signature + a little padding — assertImageUpload only sniffs the
// magic bytes, and this keeps the LONGBLOB tiny.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0),
])

describe("progressPhoto routes", () => {
  let u: Awaited<ReturnType<typeof signup>>
  let photoId: number

  beforeAll(async () => {
    u = await signup("photo")
  })

  it("rejects non-image and malformed uploads", async () => {
    const text = await request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", Buffer.from("hello"), { filename: "a.txt", contentType: "text/plain" })
      .field("muscleGroups", JSON.stringify(["chest"]))
    expect(text.status).toBe(400)

    const lyingPng = await request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", Buffer.from("definitely not an image"), {
        filename: "a.png",
        contentType: "image/png",
      })
      .field("muscleGroups", JSON.stringify(["chest"]))
    expect(lyingPng.status).toBe(400)

    const noMuscles = await request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", PNG, { filename: "a.png", contentType: "image/png" })
      .field("muscleGroups", JSON.stringify([]))
    expect(noMuscles.status).toBe(400)

    const badJson = await request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", PNG, { filename: "a.png", contentType: "image/png" })
      .field("muscleGroups", "not-json")
    expect(badJson.status).toBe(400)
  })

  it("uploads, lists, serves, and deletes photos", async () => {
    const ok = await request(app)
      .post("/api/tracking/photos/muscle")
      .set(auth(u.token))
      .attach("photo", PNG, { filename: "a.png", contentType: "image/png" })
      .field("muscleGroups", JSON.stringify(["chest", "abs"]))
      .field("notes", "week 1")
      .field("angle", "front")
    expect(ok.status).toBe(201)
    photoId = ok.body.id

    const all = await request(app).get("/api/tracking/photos/muscle").set(auth(u.token))
    expect(all.body.data.length).toBe(1)

    const group = await request(app)
      .get("/api/tracking/photos/muscle/group/chest")
      .set(auth(u.token))
    expect(group.body.data.length).toBe(1)

    const image = await request(app)
      .get(`/api/tracking/photos/muscle/${photoId}/image`)
      .set(auth(u.token))
      .buffer(true)
    expect(image.status).toBe(200)
    expect(image.headers["content-type"]).toContain("image/png")
    expect(image.body).toBeInstanceOf(Buffer)
    expect((image.body as Buffer).length).toBe(PNG.length)

    const del = await request(app).delete(`/api/tracking/photos/muscle/${photoId}`).set(auth(u.token))
    expect(del.status).toBe(200)

    const gone = await request(app).get("/api/tracking/photos/muscle").set(auth(u.token))
    expect(gone.body.data.length).toBe(0)
  })
})
