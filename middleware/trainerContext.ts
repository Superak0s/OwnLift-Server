import { Request, Response, NextFunction } from "express"
import { ForbiddenError } from "./errorHandler.js"
import { findUserById } from "../features/auth/auth.model.js"
import { hasPermission } from "../features/social/sharing/sharing.model.js"
import { areFriends } from "../features/social/friends/friends.model.js"

/**
 * Trainer mode. When `X-Trainee-Id` is present and the named user has granted
 * the authenticated caller an active `trainer` permission, req.user is
 * swapped to the trainee for the rest of the request — every read and write
 * lands on the trainee's data. The original actor is kept on req.trainer so
 * routes can attach it to WS events. No header → no-op.
 *
 * Mounted after authenticateToken on the routers the feature covers
 * (sessions, program, analytics). /api/auth deliberately never sees it — in
 * particular DELETE /api/auth/account/data stays scoped to the caller, so a
 * trainer cannot wipe a trainee's account.
 *
 * The grant is read/write but never destructive: `denyTrainer` guards every
 * route in the covered routers that erases or overwrites in bulk — the delete
 * routes, POST /api/program/upload (an upsert that replaces the whole program
 * rather than merging into it) and POST /api/sessions/rename-exercise (a bulk
 * rewrite of a split's entire set history) — so destroying a trainee's data
 * stays the trainee's own call.
 */
export function denyTrainer(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (req.trainer)
    return next(
      new ForbiddenError("Trainers cannot delete a trainee's data"),
    )
  next()
}

export async function applyTrainerContext(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const raw = req.headers["x-trainee-id"]
  if (raw == null) return next()

  const traineeId = Number(raw)
  if (!Number.isInteger(traineeId) || traineeId < 1)
    return next(new ForbiddenError("NOT_A_TRAINER"))

  // Friendship AND grant, matching friendAccess() in sharing.routes.ts.
  // removeFriend now deletes the grant rows, so the friendship check is
  // belt-and-braces against any other path that drops a friendship without
  // tearing grants down.
  const trainee = await findUserById(traineeId)
  if (
    !trainee ||
    !(await areFriends(req.user!.id, traineeId)) ||
    !(await hasPermission(traineeId, req.user!.id, "trainer"))
  )
    return next(new ForbiddenError("NOT_A_TRAINER"))

  req.trainer = { userId: req.user!.id, username: req.user!.username }
  req.user = trainee
  next()
}
