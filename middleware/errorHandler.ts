import { Request, Response, NextFunction } from "express"
import { logger } from "../utils/logger.js"

class AppError extends Error {
  statusCode: number
  details: unknown

  constructor(message: string, statusCode = 500, details: unknown = null) {
    super(message)
    this.statusCode = statusCode
    this.details = details
    Error.captureStackTrace(this, this.constructor)
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: unknown = null) {
    super(message, 400, details)
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super(`${resource} not found`, 404)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Access denied") {
    super(message, 403)
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409)
  }
}

interface ErrorResponse {
  success: false
  error: string
  details?: unknown
  stack?: string
}

export function errorHandler(
  err: AppError | Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logger.error("Error:", {
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    path: req.path,
    method: req.method,
    reqId: req.reqId,
  })

  const statusCode = (err as AppError).statusCode ?? 500
  const isDev = process.env.NODE_ENV === "development"

  // Never leak internal error details (raw DB/driver messages, stack traces)
  // for server errors in production. Anything that isn't one of our own
  // AppError subclasses has no statusCode, so it falls through to 500 and
  // gets the generic message.
  const safeMessage =
    statusCode < 500
      ? err.message
      : isDev
        ? err.message || "Internal server error"
        : "Internal server error"

  const response: ErrorResponse = { success: false, error: safeMessage }

  if (statusCode < 500 && (err as AppError).details)
    response.details = (err as AppError).details
  if (isDev && err.stack) response.stack = err.stack

  res.status(statusCode).json(response)
}
