import { Request, Response, NextFunction } from "express"
import jwt from "jsonwebtoken"
import { findUserForAuth } from "../features/auth/auth.model.js"
import { UnauthorizedError } from "./errorHandler.js"
import type { JwtPayload } from "../features/auth/auth.types.js"

// Bearer only. `header.split(" ")[1]` also accepted `Basic <jwt>` and
// `Anything <jwt>`; every one of those failed safely at jwt.verify, but the
// scheme is part of the contract and a caller sending the wrong one deserves
// the 401 to say so rather than "invalid token".
function extractToken(req: Request): string | null {
  const match = /^Bearer +(\S+)$/.exec(req.headers["authorization"] ?? "")
  return match?.[1] ?? null
}

export async function authenticateToken(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  // Mounted twice on the 2 MB-parser paths (once by server.ts to gate the
  // parser, once by the router), which meant two findUserForAuth queries per
  // program upload on an 8-connection pool.
  if (req.user) return next()

  const token = extractToken(req)
  if (!token) return next(new UnauthorizedError("Access token required"))

  try {
    const { userId, tokenVersion } = jwt.verify(
      token,
      process.env.JWT_SECRET!,
      { algorithms: ["HS256"] },
    ) as JwtPayload
    const found = await findUserForAuth(userId)
    if (!found) return next(new UnauthorizedError("User not found"))
    if (found.tokenVersion !== tokenVersion)
      return next(new UnauthorizedError("Token has been revoked"))
    req.user = found.user
    next()
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      return next(new UnauthorizedError("Invalid or expired token"))
    }
    // Infrastructure error (e.g. DB down) — let it bubble up as a 500
    next(err)
  }
}
