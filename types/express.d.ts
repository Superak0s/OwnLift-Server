import type { AuthUser } from "../features/auth/user.types.js"

export {}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}
