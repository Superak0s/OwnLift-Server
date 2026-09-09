import { describe, it, expect, beforeAll } from "vitest"
import request from "supertest"
import { app, signup, auth } from "../../tests/helpers.js"

describe("auth routes", () => {
  let u: Awaited<ReturnType<typeof signup>>

  beforeAll(async () => {
    u = await signup("auth")
  })

  it("signs up and returns a token + profile", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ username: "newuser1", email: "new1@test.local", password: "Password1", name: "New" })
    expect(res.status).toBe(201)
    expect(res.body.token).toBeTruthy()
    expect(res.body.user.username).toBe("newuser1")
    expect(res.body.user.name).toBe("New")
  })

  it("rejects duplicate usernames and emails with 409", async () => {
    const dupUser = await request(app)
      .post("/api/auth/signup")
      .send({ username: u.username, email: "other@test.local", password: "Password1" })
    expect(dupUser.status).toBe(409)
    expect(dupUser.body.error).toBe("Username already taken")

    const dupEmail = await request(app)
      .post("/api/auth/signup")
      .send({ username: "duptest99", email: `${u.username}@test.local`, password: "Password1" })
    expect(dupEmail.status).toBe(409)
    expect(dupEmail.body.error).toBe("Email already registered")
  })

  it("rejects invalid signups with 400 + details", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ username: "x", email: "bad", password: "weak" })
    expect(res.status).toBe(400)
    expect(Array.isArray(res.body.details)).toBe(true)
  })

  it("signs in with correct credentials, rejects bad ones", async () => {
    const good = await request(app)
      .post("/api/auth/signin")
      .send({ username: u.username, password: "Passw0rd-123" })
    expect(good.status).toBe(200)
    expect(good.body.token).toBeTruthy()

    const badPw = await request(app)
      .post("/api/auth/signin")
      .send({ username: u.username, password: "WrongPass1" })
    expect(badPw.status).toBe(401)

    const noUser = await request(app)
      .post("/api/auth/signin")
      .send({ username: "ghost123", password: "WrongPass1" })
    expect(noUser.status).toBe(401)
  })

  it("GET /me returns the profile, 401 without a token", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401)
    const res = await request(app).get("/api/auth/me").set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.user.username).toBe(u.username)
  })

  it("PUT /profile updates name/email and reports no-op", async () => {
    const noop = await request(app)
      .put("/api/auth/profile")
      .set(auth(u.token))
      .send({})
    expect(noop.status).toBe(200)
    expect(noop.body.message).toBe("No changes provided")

    const upd = await request(app)
      .put("/api/auth/profile")
      .set(auth(u.token))
      .send({ name: "Auth Test User" })
    expect(upd.status).toBe(200)
    expect(upd.body.user.name).toBe("Auth Test User")

    const bad = await request(app)
      .put("/api/auth/profile")
      .set(auth(u.token))
      .send({ email: "not-an-email" })
    expect(bad.status).toBe(400)
  })

  it("POST /refresh issues a working token", async () => {
    const res = await request(app).post("/api/auth/refresh").set(auth(u.token))
    expect(res.status).toBe(200)
    const me = await request(app).get("/api/auth/me").set(auth(res.body.token))
    expect(me.status).toBe(200)
    expect(me.body.user.username).toBe(u.username)
  })

  it("PUT /password verifies the current one, revokes old tokens", async () => {
    const wrong = await request(app)
      .put("/api/auth/password")
      .set(auth(u.token))
      .send({ currentPassword: "WrongPass1", newPassword: "Password2" })
    expect(wrong.status).toBe(403)

    const weak = await request(app)
      .put("/api/auth/password")
      .set(auth(u.token))
      .send({ currentPassword: "Passw0rd-123", newPassword: "weak" })
    expect(weak.status).toBe(400)

    const ok = await request(app)
      .put("/api/auth/password")
      .set(auth(u.token))
      .send({ currentPassword: "Passw0rd-123", newPassword: "Password2" })
    expect(ok.status).toBe(200)
    expect(ok.body.token).toBeTruthy()

    const revoked = await request(app).get("/api/auth/me").set(auth(u.token))
    expect(revoked.status).toBe(401)

    const fresh = await request(app).get("/api/auth/me").set(auth(ok.body.token))
    expect(fresh.status).toBe(200)
    u = { ...u, token: ok.body.token, password: "Password2" }
  })

  it("GET /account/export returns everything the server holds", async () => {
    const res = await request(app).get("/api/auth/account/export").set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.data.profile.username).toBe(u.username)
  })

  it("DELETE /account/data requires the confirmation token and wipes data", async () => {
    const noConfirm = await request(app)
      .delete("/api/auth/account/data")
      .set(auth(u.token))
      .send({})
    expect(noConfirm.status).toBe(400)

    const wrongConfirm = await request(app)
      .delete("/api/auth/account/data")
      .set(auth(u.token))
      .send({ confirmDelete: "nope" })
    expect(wrongConfirm.status).toBe(400)

    const seed = await request(app)
      .post("/api/tracking/hydration")
      .set(auth(u.token))
      .send({ amountMl: 100 })
    expect(seed.status).toBe(201)

    const ok = await request(app)
      .delete("/api/auth/account/data")
      .set(auth(u.token))
      .send({ confirmDelete: "DELETE_ALL_DATA" })
    expect(ok.status).toBe(200)

    const history = await request(app)
      .get("/api/tracking/hydration")
      .set(auth(u.token))
    expect(history.body.data.length).toBe(0)

    const stillIn = await request(app).get("/api/auth/me").set(auth(u.token))
    expect(stillIn.status).toBe(200)
  })

  it("exports and wipes the settings and custom-measurement tables too", async () => {
    const v = await signup("wipeall")

    expect(
      (await request(app).post("/api/tracking/hydration/settings").set(auth(v.token)).send({ goalMl: 3000 })).status,
    ).toBe(200)
    expect(
      (await request(app).post("/api/tracking/menstrual/settings").set(auth(v.token)).send({ periodDays: 6, cycleLengthDays: 30 })).status,
    ).toBe(200)
    const type = await request(app)
      .post("/api/tracking/custom-measurements/types")
      .set(auth(v.token))
      .send({ keyName: "forearm", label: "Forearm", unit: "cm" })
    expect(type.status).toBe(201)
    expect(
      (await request(app).post("/api/tracking/custom-measurements/values").set(auth(v.token)).send({ typeId: type.body.data.id, value: 31.5 })).status,
    ).toBe(201)

    const exported = await request(app).get("/api/auth/account/export").set(auth(v.token))
    for (const table of [
      "menstrual_settings",
      "hydration_settings",
      "measurement_custom_types",
      "measurement_custom_values",
    ]) {
      expect(exported.body.data[table]).toHaveLength(1)
    }

    expect(
      (await request(app).delete("/api/auth/account/data").set(auth(v.token)).send({ confirmDelete: "DELETE_ALL_DATA" })).status,
    ).toBe(200)

    const after = await request(app).get("/api/auth/account/export").set(auth(v.token))
    for (const table of [
      "menstrual_settings",
      "hydration_settings",
      "measurement_custom_types",
      "measurement_custom_values",
    ]) {
      expect(after.body.data[table]).toHaveLength(0)
    }
  })

  it("PUT /profile stores height, which the export reads back", async () => {
    const h = await signup("heighty")

    const bad = await request(app).put("/api/auth/profile").set(auth(h.token)).send({ heightCm: 400 })
    expect(bad.status).toBe(400)

    const ok = await request(app).put("/api/auth/profile").set(auth(h.token)).send({ heightCm: 182 })
    expect(ok.status).toBe(200)

    const exported = await request(app).get("/api/auth/account/export").set(auth(h.token))
    expect(Number(exported.body.data.profile.height_cm)).toBe(182)
  })

  it("DELETE /account re-checks the password, then deletes", async () => {
    const res = await signup("delme")

    const wrongPw = await request(app)
      .delete("/api/auth/account")
      .set(auth(res.token))
      .send({ password: "WrongPass1" })
    expect(wrongPw.status).toBe(403)

    const ok = await request(app)
      .delete("/api/auth/account")
      .set(auth(res.token))
      .send({ password: "Passw0rd-123" })
    expect(ok.status).toBe(200)

    const me = await request(app).get("/api/auth/me").set(auth(res.token))
    expect(me.status).toBe(401)
  })
})
