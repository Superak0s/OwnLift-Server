// src/types/express.d.ts
import type { AuthUser } from "./index.js"

export {}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}
