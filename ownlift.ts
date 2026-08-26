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


import {
  findUserByUsername,
  setUserAdmin,
  listAdmins,
  changePassword,
} from "./features/auth/auth.model.js"
import { listReports } from "./features/social/friends/friends.model.js"

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0]

  if (!cmd || cmd === "help") {
    console.log("Usage: ownlift <command> [...args]")
    console.log("Commands:")
    console.log("  list                     List admin users")
    console.log("  add <username>           Grant admin to a user")
    console.log("  remove <username>        Revoke admin from a user")
    console.log("  passwd <username> <pw>   Set a user's password (account recovery)")
    console.log("  reports [limit]          List user reports filed on this instance")
    process.exit(0)
  }

  try {
    if (cmd === "list") {
      const admins = await listAdmins()
      if (!admins.length) {
        console.log("No admin users found")
        process.exit(0)
      }
      console.log("Admin users:")
      for (const a of admins) {
        console.log(
          `- id=${a.id} username=${a.username} email=${a.email} name=${a.name} created_at=${a.created_at.toString()}`,
        )
      }
      process.exit(0)
    }

    if (cmd === "add" || cmd === "remove") {
      const username = args[1]
      if (!username) {
        console.error("Username required")
        process.exit(2)
      }
      const user = await findUserByUsername(username)
      if (!user) {
        console.error(`User not found: ${username}`)
        process.exit(2)
      }
      const ok = await setUserAdmin(user.id, cmd === "add")
      if (!ok) {
        console.error("Failed to update user admin status")
        process.exit(1)
      }
      console.log(`User ${username} admin=${cmd === "add"}`)
      process.exit(0)
    }

    if (cmd === "passwd") {
      const [username, newPassword] = args.slice(1)
      if (!username || !newPassword) {
        console.error("Usage: ownlift passwd <username> <newpassword>")
        process.exit(2)
      }
      if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
        console.error(
          "Password must be at least 8 characters and include a letter and a number",
        )
        process.exit(2)
      }
      const user = await findUserByUsername(username)
      if (!user) {
        console.error(`User not found: ${username}`)
        process.exit(2)
      }
      // changePassword bumps token_version, so every device signed in as this
      // user is signed out — which is what you want after a recovery reset.
      await changePassword(user.id, newPassword)
      console.log(`Password reset for ${username}. All existing sessions were signed out.`)
      process.exit(0)
    }

    if (cmd === "reports") {
      const limit = parseInt(args[1] ?? "100", 10)
      const reports = await listReports(isNaN(limit) ? 100 : limit)
      if (!reports.length) {
        console.log("No reports filed")
        process.exit(0)
      }
      console.log(`${reports.length} report(s), newest first:`)
      for (const r of reports) {
        console.log(
          `- #${r.id} ${r.created_at.toISOString()} ${r.reporter_username} reported ${r.reported_username} (${r.reason})`,
        )
        if (r.details) console.log(`    ${r.details}`)
      }
      process.exit(0)
    }

    console.error("Unknown command")
    process.exit(2)
  } catch (err) {
    console.error("Error:", (err as Error).message)
    process.exit(1)
  }
}

main()
