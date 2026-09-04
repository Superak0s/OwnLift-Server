import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest"
import http from "http"
import jwt from "jsonwebtoken"
import WebSocket from "ws"
import { createWsServer, closeWsServer } from "./wsServer.js"
import { createUser } from "../features/auth/auth.model.js"
import { uniqueName } from "../tests/helpers.js"

function tokenFor(userId: number, tokenVersion = 0): string {
  return jwt.sign({ userId, tokenVersion }, process.env.JWT_SECRET!, {
    algorithm: "HS256",
  })
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    ws.on("open", () => resolve(ws))
    ws.on("error", reject)
  })
}

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs)
    ws.once("message", (raw) => {
      clearTimeout(t)
      resolve(JSON.parse(raw.toString()))
    })
  })
}

function waitForClose(ws: WebSocket, timeoutMs = 8000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs)
    ws.once("close", (code, reason) => {
      clearTimeout(t)
      resolve({ code, reason: reason.toString() })
    })
  })
}

describe("wsServer", () => {
  let httpServer: http.Server
  let port: number
  let sockets: WebSocket[] = []

  async function makeUser(username?: string): Promise<{ userId: number; token: string }> {
    const userId = await createUser(
      username ?? uniqueName("ws"),
      `${uniqueName("ws")}@test.local`,
      "Passw0rd-123",
    )
    return { userId, token: tokenFor(userId) }
  }

  beforeAll(async () => {
    httpServer = http.createServer()
    createWsServer(httpServer)
    await new Promise<void>((resolve) => httpServer.listen(0, resolve))
    port = (httpServer.address() as any).port
  })

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        ws.close()
    }
    sockets = []
  })

  afterAll(async () => {
    for (const ws of sockets) ws.terminate()
    closeWsServer()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  })

  it("authenticates via an auth message", async () => {
    const u = await makeUser()
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "auth", token: u.token }))
    const msg = await nextMessage(ws)
    expect(msg.type).toBe("auth_success")
    expect(msg.userId).toBe(u.userId)
  })

  it("closes unauthenticated sockets after the 5s timeout", async () => {
    const ws = await connect(port)
    sockets.push(ws)
    const close = await waitForClose(ws, 8000)
    expect(close.code).toBe(4001)
    expect(close.reason).toContain("No auth message")
  })

  it.each([
    ["missing token", () => JSON.stringify({ type: "auth" }), "No token"],
    ["bad token", () => JSON.stringify({ type: "auth", token: "garbage" }), "Unauthorized"],
  ])("%s", async (_name, payload, reasonFragment) => {
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(payload())
    const close = await waitForClose(ws)
    expect(close.code).toBe(4001)
    expect(close.reason).toContain(reasonFragment)
  })

  it("closes a revoked token", async () => {
    const u = await makeUser()
    const revoked = tokenFor(u.userId, 999)
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "auth", token: revoked }))
    const close = await waitForClose(ws)
    expect(close.code).toBe(4001)
    expect(close.reason).toContain("revoked")
  })

  it("rejects messages before auth and caps pre-auth chatter", async () => {
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "push_joint_progress", jointSessionId: 1 }))
    const err = await nextMessage(ws)
    expect(err.type).toBe("error")
    expect(err.message).toBe("Not authenticated")

    for (let i = 0; i < 11; i++) ws.send(JSON.stringify({ type: "noise" }))
    const close = await waitForClose(ws)
    expect(close.code).toBe(4001)
    expect(close.reason).toContain("too many messages before auth")
  })

  it("rejects oversized messages", async () => {
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "noise", pad: "x".repeat(9000) }))
    const err = await nextMessage(ws)
    expect(err.type).toBe("error")
    expect(err.message).toBe("Message too large")
  })

  it("rate limits more than 20 messages per second", async () => {
    const u = await makeUser()
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "auth", token: u.token }))
    await nextMessage(ws) // auth_success

    for (let i = 0; i < 25; i++) ws.send(JSON.stringify({ type: "noise" }))
    let limited = false
    for (let i = 0; i < 10 && !limited; i++) {
      const msg = await nextMessage(ws)
      if (msg.type === "error" && msg.message === "Rate limit exceeded") limited = true
    }
    expect(limited).toBe(true)
  })

  it("replaces a zombie connection from the same user", async () => {
    const u = await makeUser()
    const ws1 = await connect(port)
    sockets.push(ws1)
    ws1.send(JSON.stringify({ type: "auth", token: u.token }))
    await nextMessage(ws1)

    const ws2 = await connect(port)
    sockets.push(ws2)
    ws2.send(JSON.stringify({ type: "auth", token: u.token }))
    await nextMessage(ws2)

    const close = await waitForClose(ws1)
    expect(close.code).toBe(1000)
    expect(close.reason).toContain("Replaced")
  })

  it("pushes joint progress to the partner only for participants", async () => {
    // not a participant of session 999999
    const u = await makeUser()
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "auth", token: u.token }))
    await nextMessage(ws)
    ws.send(JSON.stringify({ type: "push_joint_progress", jointSessionId: 999999 }))
    const err = await nextMessage(ws)
    expect(err.type).toBe("error")
    expect(err.message).toBe("Not a participant")
  })

  it("closes all sockets on shutdown", async () => {
    const u = await makeUser()
    const ws = await connect(port)
    sockets.push(ws)
    ws.send(JSON.stringify({ type: "auth", token: u.token }))
    await nextMessage(ws)
    closeWsServer()
    const close = await waitForClose(ws)
    expect(close.code).toBe(1001)
  })
})
