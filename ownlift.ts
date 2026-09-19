#!/usr/bin/env node
/*
  ownlift.ts
  Simple CLI for viewing and adding/removing admin flags from users.
  Usage (dev):
    pnpm ownlift list
    pnpm ownlift add <username>
    pnpm ownlift remove <username>
  Usage (docker, after build):
    docker exec <container> node dist/ownlift.js list
*/


import { createInterface } from "readline"
import { pathToFileURL } from "url"
import {
  findUserByUsername,
  setUserAdmin,
  listAdmins,
  listUsers,
  changePassword,
} from "./features/auth/auth.model.js"
import { listReports } from "./features/social/friends/friends.model.js"

/** Reads one line from stdin. Not hidden — a TTY echo-off needs raw mode and a
 * hand-rolled line reader, and this runs on a box the operator already owns. */
async function promptPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await new Promise<string>((r) => rl.question("New password: ", r))).trim()
  } finally {
    rl.close()
  }
}

export async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const cmd = args[0]

  if (!cmd || cmd === "help") {
    console.log("Usage: ownlift <command> [...args]")
    console.log("Commands:")
    console.log("  list                     List all users, admins first")
    console.log("  add <username>           Grant admin to a user")
    console.log("  remove <username>        Revoke admin from a user")
    console.log("  passwd <username> [pw]   Set a user's password (account recovery;")
    console.log("                           omit <pw> to be prompted, keeping it out of")
    console.log("                           shell history and ps)")
    console.log("  reports [limit]          List user reports filed on this instance")
    return 0
  }

  try {
    if (cmd === "list") {
      const users = await listUsers()
      if (!users.length) {
        console.log("No users found")
        return 0
      }
      console.log(`${users.length} user(s), admins first:`)
      for (const u of users) {
        console.log(
          `- ${u.isAdmin ? "[admin]" : "       "} id=${u.id} username=${u.username} email=${u.email} name=${u.name} createdAt=${u.createdAt.toString()}`,
        )
      }
      return 0
    }

    if (cmd === "add" || cmd === "remove") {
      const username = args[1]
      if (!username) {
        console.error("Username required")
        return 2
      }
      const user = await findUserByUsername(username)
      if (!user) {
        console.error(`User not found: ${username}`)
        return 2
      }
      // Demoting the only admin locks the box out of every admin action, and
      // this CLI is the sole way back in — so it has to be refused here.
      if (cmd === "remove") {
        const admins = await listAdmins()
        if (admins.length <= 1 && admins[0]?.id === user.id) {
          console.error(
            `Refusing to remove the only admin (${username}). Grant admin to someone else first.`,
          )
          return 2
        }
      }
      const ok = await setUserAdmin(user.id, cmd === "add")
      if (!ok) {
        console.error("Failed to update user admin status")
        return 1
      }
      console.log(`User ${username} admin=${cmd === "add"}`)
      return 0
    }

    if (cmd === "passwd") {
      const [username] = args.slice(1)
      if (!username) {
        console.error("Usage: ownlift passwd <username> [newpassword]")
        return 2
      }
      // argv stays the scriptable path, but a password given there lands in
      // ~/.bash_history and in `ps aux` for the life of the command. Prompt
      // when it's omitted.
      const newPassword = args[2] ?? (await promptPassword())
      if (!newPassword) {
        console.error("No password entered")
        return 2
      }
      if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
        console.error(
          "Password must be at least 8 characters and include a letter and a number",
        )
        return 2
      }
      const user = await findUserByUsername(username)
      if (!user) {
        console.error(`User not found: ${username}`)
        return 2
      }
      // changePassword bumps token_version, so every device signed in as this
      // user is signed out — which is what you want after a recovery reset.
      await changePassword(user.id, newPassword)
      console.log(`Password reset for ${username}. All existing sessions were signed out.`)
      return 0
    }

    if (cmd === "reports") {
      // parseInt("-5") is -5, not NaN, and reached `LIMIT -5` as a raw MySQL
      // syntax error. Clamped the same way queryLimit clamps the HTTP routes.
      const parsed = parseInt(args[1] ?? "100", 10)
      const limit = Math.min(Math.max(Number.isNaN(parsed) ? 100 : parsed, 1), 1000)
      const reports = await listReports(limit)
      if (!reports.length) {
        console.log("No reports filed")
        return 0
      }
      console.log(`${reports.length} report(s), newest first:`)
      for (const r of reports) {
        console.log(
          `- #${r.id} ${r.created_at} ${r.reporter_username} reported ${r.reported_username} (${r.reason})`,
        )
        if (r.details) console.log(`    ${r.details}`)
      }
      return 0
    }

    console.error("Unknown command")
    return 2
  } catch (err) {
    console.error("Error:", (err as Error).message)
    return 1
  }
}

// Only run when launched directly, so tests can import main() without side
// effects. pathToFileURL makes relative launch scripts compare equal.
const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) void main().then((code) => process.exit(code))
