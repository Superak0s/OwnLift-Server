import type { AuthUser } from "../features/auth/user.types.js"

export {}

declare global {
  namespace Express {
    /** The authenticated caller while req.user is swapped to their trainee. */
    interface ActingTrainer {
      userId: number
      username: string
    }
    interface Request {
      user?: AuthUser
      trainer?: ActingTrainer
    }
  }
}
