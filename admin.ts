#!/usr/bin/env ts-node
/*
  admin.ts
  Simple CLI for viewing and adding/removing admin flags from users.
  Usage:
    ts-node --files admin.ts list
    ts-node --files admin.ts add <username>
    ts-node --files admin.ts remove <username>
*/

import dotenv from "dotenv"
dotenv.config()

import { findUserByUsername, setUserAdmin, listAdmins } from "./models/auth"

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0]

  if (!cmd || cmd === "help") {
    console.log("Usage: admin.ts <command> [...args]")
    console.log("Commands:")
    console.log("  list                     List admin users")
    console.log("  add <username>           Grant admin to a user")
    console.log("  remove <username>        Revoke admin from a user")
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

    console.error("Unknown command")
    process.exit(2)
  } catch (err) {
    console.error("Error:", (err as Error).message)
    process.exit(1)
  }
}

main()
