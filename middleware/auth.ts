// src/middleware/auth.ts
import { Request, Response, NextFunction } from "express"
import jwt from "jsonwebtoken"
import { findUserById } from "../models/auth"
import { UnauthorizedError } from "./errorHandler"
import type { JwtPayload } from "../types"

function extractToken(req: Request): string | null {
  const header = req.headers["authorization"]
  return header ? (header.split(" ")[1] ?? null) : null
}

export async function authenticateToken(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req)
  if (!token) return next(new UnauthorizedError("Access token required"))

  try {
    const { userId } = jwt.verify(token, process.env.JWT_SECRET!, {
      algorithms: ["HS256"],
    }) as JwtPayload
    const user = await findUserById(userId)
    if (!user) return next(new UnauthorizedError("User not found"))
    req.user = user
    next()
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      return next(new UnauthorizedError("Invalid or expired token"))
    }
    // Infrastructure error (e.g. DB down) — let it bubble up as a 500
    next(err)
  }
}

export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req)
  if (!token) return next()

  try {
    const { userId } = jwt.verify(token, process.env.JWT_SECRET!, {
      algorithms: ["HS256"],
    }) as JwtPayload
    const user = await findUserById(userId)
    if (user) req.user = user
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      // Invalid token — continue unauthenticated (expected path)
      return next()
    }
    // Infrastructure error — log it but don't block the request,
    // since this middleware is explicitly optional.
    console.error(
      "[optionalAuth] infrastructure error:",
      (err as Error).message,
    )
  }
  next()
}
