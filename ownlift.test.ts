import { describe, it, expect } from "vitest"
import { main } from "./ownlift.js"
import { uniqueName } from "./tests/helpers.js"
import { createUser } from "./features/auth/auth.model.js"
import { reportUser } from "./features/social/friends/friends.model.js"
import { pool } from "./config/database.js"

async function runCli(args: string[]): Promise<{ code: number; out: string }> {
  const logs: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a: unknown[]) => logs.push(a.join(" "))
  console.error = (...a: unknown[]) => logs.push(a.join(" "))
  const prev = process.argv
  process.argv = ["node", "ownlift", ...args]
  try {
    return { code: await main(), out: logs.join("\n") }
  } finally {
    console.log = origLog
    console.error = origErr
    process.argv = prev
  }
}

describe("ownlift CLI", () => {
  it("prints usage and exits 0 with no command", async () => {
    const r = await runCli([])
    expect(r.code).toBe(0)
    expect(r.out).toContain("Usage: ownlift")
  })

  it("add/remove toggle the admin flag", async () => {
    const username = uniqueName("adm")
    await createUser(username, `${username}@test.local`, "Passw0rd-123")

    const missing = await runCli(["add"])
    expect(missing.code).toBe(2)

    const ghost = await runCli(["add", uniqueName("nope")])
    expect(ghost.code).toBe(2)
    expect(ghost.out).toContain("User not found")

    const add = await runCli(["add", username])
    expect(add.code).toBe(0)
    expect(add.out).toContain(`admin=true`)

    let [rows] = await pool.query("SELECT is_admin FROM users WHERE username = ?", [username])
    expect((rows as any[])[0].is_admin).toBe(1)

    const remove = await runCli(["remove", username])
    expect(remove.code).toBe(0)
    expect(remove.out).toContain(`admin=false`)

    ;[rows] = await pool.query("SELECT is_admin FROM users WHERE username = ?", [username])
    expect((rows as any[])[0].is_admin).toBe(0)
  })

  it("passwd validates input and resets the password", async () => {
    const username = uniqueName("pw")
    await createUser(username, `${username}@test.local`, "Passw0rd-123")

    expect((await runCli(["passwd"])).code).toBe(2)
    expect((await runCli(["passwd", username, "short1"])).code).toBe(2)
    expect((await runCli(["passwd", uniqueName("nope"), "Valid123"])).code).toBe(2)

    const ok = await runCli(["passwd", username, "NewPass99"])
    expect(ok.code).toBe(0)
    expect(ok.out).toContain("All existing sessions were signed out")

    const [rows] = await pool.query("SELECT password_hash FROM users WHERE username = ?", [username])
    const hash = (rows as any[])[0].password_hash as string
    const bcrypt = (await import("bcryptjs")).default ?? (await import("bcryptjs"))
    expect(await bcrypt.compare("NewPass99", hash)).toBe(true)
  })

  it("lists admins and reports", async () => {
    const admin = uniqueName("lsadm")
    await createUser(admin, `${admin}@test.local`, "Passw0rd-123")
    await runCli(["add", admin])

    const list = await runCli(["list"])
    expect(list.code).toBe(0)
    expect(list.out).toContain("Admin users:")
    expect(list.out).toContain(admin)

    const a = uniqueName("rep-a")
    const b = uniqueName("rep-b")
    await createUser(a, `${a}@test.local`, "Passw0rd-123")
    await createUser(b, `${b}@test.local`, "Passw0rd-123")
    const [rep] = await pool.query("SELECT id FROM users WHERE username = ?", [a])
    const [repd] = await pool.query("SELECT id FROM users WHERE username = ?", [b])
    await reportUser((rep as any[])[0].id, (repd as any[])[0].id, "spam", "test report")

    const reports = await runCli(["reports"])
    expect(reports.code).toBe(0)
    expect(reports.out).toContain(`reported ${b}`)
  })
})
