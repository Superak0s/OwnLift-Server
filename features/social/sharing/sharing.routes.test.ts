import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../../tests/helpers.js"

describe("sharing routes", () => {
  let a: Awaited<ReturnType<typeof signup>>
  let b: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    a = await signup("shara")
    b = await signup("sharb")

    const req = await request(app)
      .post("/api/friends/request")
      .set(auth(a.token))
      .send({ username: b.username })
    expect(req.status).toBe(201)
    const accept = await request(app)
      .post(`/api/friends/request/${req.body.friendshipId}/accept`)
      .set(auth(b.token))
    expect(accept.status).toBe(200)
  })

  it("grants and revokes permissions", async () => {
    const noFriend = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(a.token))
      .send({ friendId: 999999, permissionType: "history" })
    expect(noFriend.status).toBe(403)

    const noType = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(a.token))
      .send({ friendId: b.user.id })
    expect(noType.status).toBe(400)

    const programNoPayload = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(a.token))
      .send({ friendId: b.user.id, permissionType: "program" })
    expect(programNoPayload.status).toBe(400)

    const bigPayload = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(a.token))
      .send({
        friendId: b.user.id,
        permissionType: "program",
        payload: { programData: "x".repeat(512 * 1024 + 1) },
      })
    // express.json's 50kb body limit rejects it before the route sees it
    expect(bigPayload.status).toBe(413)

    const grant = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(a.token))
      .send({ friendId: b.user.id, permissionType: "history" })
    expect(grant.status).toBe(201)

    const granted = await request(app).get("/api/sharing/permissions/granted").set(auth(a.token))
    expect(granted.body.count).toBe(1)

    const received = await request(app).get("/api/sharing/permissions/received").set(auth(b.token))
    expect(received.body.count).toBe(1)

    const revoke = await request(app)
      .delete(`/api/sharing/permissions/${grant.body.permissionId}`)
      .set(auth(a.token))
    expect(revoke.status).toBe(200)

    const revokeAgain = await request(app)
      .delete(`/api/sharing/permissions/${grant.body.permissionId}`)
      .set(auth(a.token))
    expect(revokeAgain.status).toBe(404)

    // history access again for the rest of the suite
    const regrant = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(a.token))
      .send({ friendId: b.user.id, permissionType: "history" })
    expect(regrant.status).toBe(201)
  })

  it("lets a friend read shared history after permission is granted", async () => {
    const start = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 1, dayTitle: "Shared Day", split: "push" })
    expect(start.status).toBe(200)
    const sessionId = start.body.session.id

    const set = await request(app)
      .post(`/api/sessions/${sessionId}/set`)
      .set(auth(a.token))
      .send({
        exerciseName: "Squat",
        setIndex: 0,
        startTime: "2024-02-01T09:00:00Z",
        endTime: "2024-02-01T09:00:45Z",
        weight: 100,
        reps: 5,
      })
    expect(set.status).toBe(200)
    await request(app).post(`/api/sessions/${sessionId}/end`).set(auth(a.token)).send({})

    const sessions = await request(app)
      .get(`/api/sharing/sessions/friend/${a.user.id}`)
      .set(auth(b.token))
    expect(sessions.status).toBe(200)
    expect(sessions.body.sessions.some((s: any) => s.id === sessionId)).toBe(true)

    const details = await request(app)
      .get(`/api/sharing/sessions/friend/${a.user.id}/${sessionId}`)
      .set(auth(b.token))
    expect(details.status).toBe(200)
    expect(details.body.session.setTimings.length).toBe(1)

    const missing = await request(app)
      .get(`/api/sharing/sessions/friend/${a.user.id}/999999`)
      .set(auth(b.token))
    expect(missing.status).toBe(404)
  })

  it("enforces watch permissions", async () => {
    const bStatus = await request(app)
      .get(`/api/sharing/joint-sessions/friend/${b.user.id}/status`)
      .set(auth(a.token))
    expect(bStatus.status).toBe(200)
    expect(bStatus.body.hasActiveSession).toBe(false)

    const watchNoPerm = await request(app)
      .get(`/api/sharing/watch/friend/${a.user.id}/active`)
      .set(auth(b.token))
    expect(watchNoPerm.status).toBe(403)

    const grant = await request(app)
      .post("/api/sharing/permissions")
      .set(auth(a.token))
      .send({ friendId: b.user.id, permissionType: "watch_session" })
    expect(grant.status).toBe(201)

    const live = await request(app)
      .post("/api/sessions/start")
      .set(auth(a.token))
      .send({ dayNumber: 2, dayTitle: "Live Day", split: "push" })
    expect(live.status).toBe(200)
    const liveId = live.body.session.id

    const active = await request(app)
      .get(`/api/sharing/watch/friend/${a.user.id}/active`)
      .set(auth(b.token))
    expect(active.status).toBe(200)
    expect(active.body.session.sessionId).toBe(liveId)

    const liveView = await request(app)
      .get(`/api/sharing/watch/friend/${a.user.id}/session/${liveId}/live`)
      .set(auth(b.token))
    expect(liveView.status).toBe(200)

    const wrongSession = await request(app)
      .get(`/api/sharing/watch/friend/${a.user.id}/session/999999/live`)
      .set(auth(b.token))
    expect(wrongSession.status).toBe(404)
  })

  it("runs a full joint-session flow", async () => {
    const bStart = await request(app)
      .post("/api/sessions/start")
      .set(auth(b.token))
      .send({ dayNumber: 3, dayTitle: "B Day", split: "pull" })
    expect(bStart.status).toBe(200)

    const noSessionUser = await signup("sharc")
    const noSession = await request(app)
      .post("/api/sharing/joint-sessions/invite")
      .set(auth(noSessionUser.token))
      .send({ toUserId: b.user.id })
    // not friends (403) before the active-session check even matters
    expect(noSession.status).toBe(403)

    const invite = await request(app)
      .post("/api/sharing/joint-sessions/invite")
      .set(auth(a.token))
      .send({ toUserId: b.user.id })
    expect(invite.status).toBe(201)
    const inviteId = invite.body.inviteId

    const notForYou = await request(app)
      .post(`/api/sharing/joint-sessions/invites/${inviteId}/accept`)
      .set(auth(noSessionUser.token))
    expect(notForYou.status).toBe(403)

    const accept = await request(app)
      .post(`/api/sharing/joint-sessions/invites/${inviteId}/accept`)
      .set(auth(b.token))
    expect(accept.status).toBe(200)
    const jointSession = accept.body.jointSession
    expect(jointSession.participants.length).toBe(2)
    const jointId = jointSession.id

    const progress = await request(app)
      .patch(`/api/sharing/joint-sessions/${jointId}/progress`)
      .set(auth(a.token))
      .send({ exerciseIndex: 0, setIndex: 1, exerciseName: "Bench", readyForNext: true })
    expect(progress.status).toBe(200)

    const strangerProgress = await request(app)
      .patch(`/api/sharing/joint-sessions/${jointId}/progress`)
      .set(auth(noSessionUser.token))
      .send({ exerciseIndex: 0 })
    expect(strangerProgress.status).toBe(404)

    const leave = await request(app)
      .delete(`/api/sharing/joint-sessions/${jointId}/leave`)
      .set(auth(b.token))
    expect(leave.status).toBe(200)

    const leaveAgain = await request(app)
      .delete(`/api/sharing/joint-sessions/${jointId}/leave`)
      .set(auth(b.token))
    // leaving only ends the session; the participant row stays, so it is idempotent
    expect(leaveAgain.status).toBe(200)

    // decline path with a fresh invite
    const invite2 = await request(app)
      .post("/api/sharing/joint-sessions/invite")
      .set(auth(a.token))
      .send({ toUserId: b.user.id })
    expect(invite2.status).toBe(201)

    const decline = await request(app)
      .post(`/api/sharing/joint-sessions/invites/${invite2.body.inviteId}/decline`)
      .set(auth(b.token))
    expect(decline.status).toBe(200)

    const acceptExpired = await request(app)
      .post(`/api/sharing/joint-sessions/invites/${invite2.body.inviteId}/accept`)
      .set(auth(b.token))
    expect(acceptExpired.status).toBe(409)

    const ghostInvite = await request(app)
      .post(`/api/sharing/joint-sessions/invites/999999/accept`)
      .set(auth(b.token))
    expect(ghostInvite.status).toBe(404)
  })
})
