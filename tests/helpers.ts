import request from "supertest"
import { app } from "../server.js"

export { app }

let n = 0
const stamp = Date.now().toString(36)

export function uniqueName(prefix: string): string {
  n += 1
  return `${prefix}_${stamp}${n}`.slice(0, 20)
}

export async function signup(prefix = "u", password = "Passw0rd-123") {
  const username = uniqueName(prefix)
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ username, email: `${username}@test.local`, password })
  if (res.status !== 201)
    throw new Error(`signup ${username} failed: ${res.status} ${res.text}`)
  return { username, token: res.body.token, user: res.body.user, password }
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` }
}
