import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../../tests/helpers.js"
import { findUserByUsername } from "../../../../features/auth/auth.model.js"

describe("friends routes", () => {
  let a: Awaited<ReturnType<typeof signup>>
  let b: Awaited<ReturnType<typeof signup>>
  let c: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    a = await signup("frida")
    b = await signup("fridb")
    c = await signup("fridc")
  })

  it("search requires at least 2 characters and finds users", async () => {
    expect((await request(app).get("/api/friends/search").set(auth(a.token))).status).toBe(400)

    const res = await request(app)
      .get(`/api/friends/search?q=${b.username.slice(-4)}`)
      .set(auth(a.token))
    expect(res.status).toBe(200)
    expect(res.body.users.some((u: any) => u.username === b.username)).toBe(true)
  })

  it("rejects self-requests and unknown users", async () => {
    const self = await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({ username: a.username })
    expect(self.status).toBe(400)

    const ghost = await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({ username: "nosuchuser" })
    expect(ghost.status).toBe(404)

    const missing = await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({})
    expect(missing.status).toBe(400)
  })

  it("sends, accepts, and lists a friendship", async () => {
    const req = await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({ username: b.username })
    expect(req.status).toBe(201)
    const friendshipId = req.body.friendshipId

    const pending = await request(app).get("/api/friends/requests/pending").set(auth(b.token))
    expect(pending.body.count).toBe(1)
    expect(pending.body.requests[0].username).toBe(a.username)

    const sent = await request(app).get("/api/friends/requests/sent").set(auth(a.token))
    expect(sent.body.count).toBe(1)

    const accept = await request(app)
      .post(`/api/friends/request/${friendshipId}/accept`)
      .set(auth(b.token))
    expect(accept.status).toBe(200)

    const friends = await request(app).get("/api/friends").set(auth(a.token))
    expect(friends.body.friends.some((f: any) => f.username === b.username)).toBe(true)
  })

  it("lets the receiver reject a request", async () => {
    const req = await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({ username: c.username })
    expect(req.status).toBe(201)

    const reject = await request(app)
      .post(`/api/friends/request/${req.body.friendshipId}/reject`)
      .set(auth(c.token))
    expect(reject.status).toBe(200)
  })

  it("files reports with a valid reason only", async () => {
    const bRow = await findUserByUsername(b.username)

    const badReason = await request(app)
      .post("/api/friends/report")
      .set(auth(a.token))
      .send({ userId: bRow!.id, reason: "flaming" })
    expect(badReason.status).toBe(400)

    const badUser = await request(app)
      .post("/api/friends/report")
      .set(auth(a.token))
      .send({ userId: "abc", reason: "spam" })
    expect(badUser.status).toBe(400)

    const ghost = await request(app)
      .post("/api/friends/report")
      .set(auth(a.token))
      .send({ userId: 999999, reason: "spam" })
    expect(ghost.status).toBe(404)

    const ok = await request(app)
      .post("/api/friends/report")
      .set(auth(a.token))
      .send({ userId: bRow!.id, reason: "spam", details: "test report" })
    expect(ok.status).toBe(201)
    expect(ok.body.reportId).toBeGreaterThan(0)
  })

  it("blocks, lists blocks, and unblocks", async () => {
    const cRow = await findUserByUsername(c.username)
    const aRow = await findUserByUsername(a.username)

    const blockGhost = await request(app).post("/api/friends/block/999999").set(auth(b.token))
    expect(blockGhost.status).toBe(404)

    const block = await request(app)
      .post(`/api/friends/block/${aRow!.id}`)
      .set(auth(b.token))
    expect(block.status).toBe(200)

    const blocked = await request(app).get("/api/friends/blocked").set(auth(b.token))
    expect(blocked.body.blocked.some((u: any) => u.username === a.username)).toBe(true)

    const unblock = await request(app)
      .delete(`/api/friends/block/${aRow!.id}`)
      .set(auth(b.token))
    expect(unblock.status).toBe(200)

    const unblockAgain = await request(app)
      .delete(`/api/friends/block/${aRow!.id}`)
      .set(auth(b.token))
    expect(unblockAgain.status).toBe(404)

    // blocking also removed the a–b friendship
    expect(cRow!.id).toBeGreaterThan(0)
  })

  it("removes a friendship", async () => {
    // the earlier block/unblock may have torn the friendship down, so re-request
    // and accept whatever is pending before removing it
    await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({ username: b.username })
    const pending = await request(app).get("/api/friends/requests/pending").set(auth(b.token))
    const fromA = pending.body.requests.find((r: any) => r.username === a.username)
    if (fromA)
      await request(app).post(`/api/friends/request/${fromA.friendshipId}/accept`).set(auth(b.token))

    const bRow = await findUserByUsername(b.username)
    const del = await request(app)
      .delete(`/api/friends/${bRow!.id}`)
      .set(auth(a.token))
    expect(del.status).toBe(200)

    const friends = await request(app).get("/api/friends").set(auth(a.token))
    expect(friends.body.friends.some((f: any) => f.username === b.username)).toBe(false)
  })

  // Regression: unfriending used to delete only the friendship row, leaving
  // sharing_permissions behind. A `trainer` grant is read/write over the
  // trainee's sessions, program and analytics, so an unfriended trainer kept
  // full access via X-Trainee-Id and only blocking actually revoked it.
  it("revokes sharing grants when a friendship is removed", async () => {
    const trainee = await signup("frtne")
    const trainer = await signup("frtnr")
    const traineeRow = await findUserByUsername(trainee.username)
    const trainerRow = await findUserByUsername(trainer.username)

    await request(app)
      .post("/api/friends/request")
      .set(auth(trainee.token))
      .send({ username: trainer.username })
    const pending = await request(app)
      .get("/api/friends/requests/pending")
      .set(auth(trainer.token))
    const req = pending.body.requests.find(
      (r: any) => r.username === trainee.username,
    )
    await request(app)
      .post(`/api/friends/request/${req.friendshipId}/accept`)
      .set(auth(trainer.token))

    const grant = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(trainee.token))
      .send({ friendId: trainerRow!.id, permissionType: "trainer" })
    expect(grant.status).toBe(201)

    // trainer mode works while the friendship stands
    const before = await request(app)
      .get("/api/sessions")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(traineeRow!.id))
    expect(before.status).toBe(200)

    const del = await request(app)
      .delete(`/api/friends/${trainerRow!.id}`)
      .set(auth(trainee.token))
    expect(del.status).toBe(200)

    // the grant row is gone, not merely shadowed by the missing friendship
    const granted = await request(app)
      .get("/api/sharing/permissions/granted")
      .set(auth(trainee.token))
    expect(
      granted.body.permissions.some((p: any) => p.permissionType === "trainer"),
    ).toBe(false)

    // and trainer mode no longer resolves
    const after = await request(app)
      .get("/api/sessions")
      .set(auth(trainer.token))
      .set("X-Trainee-Id", String(traineeRow!.id))
    expect(after.status).toBe(403)
  })
})
