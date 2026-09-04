import { describe, it, expect } from "vitest"
import request from "supertest"
import packageJson from "./package.json" with { type: "json" }
import { app, signup, auth } from "./tests/helpers.js"

describe("app-level routes", () => {
  it("GET /healthz is public and checks the DB", async () => {
    const res = await request(app).get("/healthz")
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("OK")
  })

  it("unknown API routes 404", async () => {
    const res = await request(app).get("/api/definitely-not-a-route")
    expect(res.status).toBe(404)
    expect(res.body.error).toBe("Route not found")
  })

  it("GET /api/version requires auth and reports the package version", async () => {
    expect((await request(app).get("/api/version")).status).toBe(401)

    const u = await signup("vers")
    const res = await request(app).get("/api/version").set(auth(u.token))
    expect(res.status).toBe(200)
    expect(res.body.version).toBe(packageJson.version)
  })
})
