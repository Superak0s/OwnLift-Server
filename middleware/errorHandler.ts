// src/middleware/errorHandler.ts
import { Request, Response, NextFunction } from "express"

export class AppError extends Error {
  statusCode: number
  details: unknown
  isOperational = true

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
  console.error("Error:", {
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    path: req.path,
    method: req.method,
  })

  const statusCode = (err as AppError).statusCode ?? 500
  const isOperational = (err as AppError).isOperational === true
  const isDev = process.env.NODE_ENV === "development"

  // Never leak internal error details (raw DB/driver messages, stack traces)
  // for server errors in production. Only trusted operational errors (our own
  // AppError subclasses) expose their message; everything else is generic.
  const safeMessage =
    statusCode < 500 && isOperational
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

/** Wraps an async route handler so rejections are forwarded to `next`. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}
