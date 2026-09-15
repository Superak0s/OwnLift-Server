import { Request, Response, NextFunction } from "express"
import { logger } from "../utils/logger.js"

class AppError extends Error {
  statusCode: number
  details: unknown
  // Machine-readable discriminator for clients that need to tell two errors
  // with the same status apart (see REFRESH_REUSED).
  code?: string

  constructor(
    message: string,
    statusCode = 500,
    details: unknown = null,
    code?: string,
  ) {
    super(message)
    this.statusCode = statusCode
    this.details = details
    this.code = code
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
  constructor(message = "Unauthorized", code?: string) {
    super(message, 401, null, code)
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

/**
 * A violated CHECK constraint (or out-of-range value) is a bad request, not a
 * server error. Matched on errno, not err.code: mysql2's name table predates
 * 4025 and mislabels it (ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE).
 * 4025 = ER_CHECK_CONSTRAINT_VIOLATED, 1264 = ER_WARN_DATA_OUT_OF_RANGE,
 * 1265 = WARN_DATA_TRUNCATED.
 */
export function throwCheckViolation(err: unknown, message: string): never {
  const errno = (err as { errno?: number }).errno
  if (errno === 4025 || errno === 1264 || errno === 1265)
    throw new ValidationError(message)
  throw err
}

interface ErrorResponse {
  success: false
  error: string
  code?: string
  details?: unknown
  stack?: string
}

export function errorHandler(
  err: AppError | Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // multer raises its own error class with no statusCode; the one a client can
  // fix is a file over the size limit.
  if (err.name === "MulterError") {
    const status = (err as { code?: string }).code === "LIMIT_FILE_SIZE" ? 413 : 400
    res.status(status).json({ success: false, error: err.message })
    return
  }

  // A column overflow (1406, ER_DATA_TOO_LONG) is a client that sent more than
  // one field holds — 400 wherever it happens, instead of a per-route length
  // check for every string column. The generic message is deliberate: the
  // driver's includes table and column names.
  if ((err as { errno?: number }).errno === 1406) {
    res.status(400).json({ success: false, error: "Value too long for its field" })
    return
  }

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

  // Only our own errors carry a code clients can act on; driver codes
  // (ER_DUP_ENTRY, ...) are internal details and stay out of 5xx responses.
  if (statusCode < 500 && (err as AppError).code)
    response.code = (err as AppError).code
  if (statusCode < 500 && (err as AppError).details)
    response.details = (err as AppError).details
  if (isDev && err.stack) response.stack = err.stack

  res.status(statusCode).json(response)
}
