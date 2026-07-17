// src/middleware/validation.ts
import { Request, Response, NextFunction } from "express"
import { ValidationError } from "./errorHandler"

// ─── Field length limits ──────────────────────────────────────────────────────
// Prevents oversized strings from passing body-size checks and being stored.
// Adjust values to match your DB column sizes.

const MAX_LENGTHS = {
  username: 20,
  email: 255,
  password: 128,
  name: 128,
  dayTitle: 255,
  exerciseName: 255,
  muscleGroup: 128,
  note: 1000,
  personName: 128,
  time: 8,
} as const

// ─── Primitive validators (pure functions, no side-effects) ───────────────────

export const validateEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
export const validateUsername = (v: string) => /^[a-zA-Z0-9_]{3,20}$/.test(v)
export const validatePassword = (v: string) => !!v && v.length >= 8
export const validatePositiveNumber = (v: unknown): v is number =>
  typeof v === "number" && v > 0 && !isNaN(v)
export const validateInteger = (v: unknown): v is number => Number.isInteger(v)
export const validateISODate = (v: string) => !isNaN(new Date(v).getTime())
export const validateEnum = (v: unknown, allowed: unknown[]) =>
  allowed.includes(v)

/** Returns an error message if the string exceeds the limit, otherwise null. */
function checkMaxLength(
  value: string,
  field: keyof typeof MAX_LENGTHS,
): string | null {
  const limit = MAX_LENGTHS[field]
  return value.length > limit
    ? `${field} must not exceed ${limit} characters`
    : null
}

// ─── Middleware factories ─────────────────────────────────────────────────────

/** Reject requests that are missing any of the listed body fields.
 *
 *  Wrapped in a try-catch so a synchronous throw is forwarded to next()
 *  and works correctly on both Express 4 and Express 5.
 */
export function validateRequired(requiredFields: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const missing = requiredFields.filter(
        (f) =>
          req.body[f] === undefined ||
          req.body[f] === null ||
          req.body[f] === "",
      )
      if (missing.length > 0) {
        throw new ValidationError(
          `Missing required fields: ${missing.join(", ")}`,
        )
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

/** Reject query params that are not in the allow-list. */
export function validateQueryParams(allowedParams: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const invalid = Object.keys(req.query).filter(
        (k) => !allowedParams.includes(k),
      )
      if (invalid.length > 0) {
        throw new ValidationError(
          `Invalid query parameters: ${invalid.join(", ")}`,
        )
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

// ─── Domain-specific middleware ───────────────────────────────────────────────

export function validateRegistration(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const { username, email, password } = req.body
    const errors: string[] = []

    if (!username) {
      errors.push("Username is required")
    } else {
      if (!validateUsername(username))
        errors.push(
          "Username must be 3-20 characters (letters, numbers, underscores)",
        )
      const lenErr = checkMaxLength(username, "username")
      if (lenErr) errors.push(lenErr)
    }

    if (!email) {
      errors.push("Email is required")
    } else {
      if (!validateEmail(email)) errors.push("Invalid email format")
      const lenErr = checkMaxLength(email, "email")
      if (lenErr) errors.push(lenErr)
    }

    if (!password) {
      errors.push("Password is required")
    } else {
      if (!validatePassword(password))
        errors.push("Password must be at least 8 characters")
      const lenErr = checkMaxLength(password, "password")
      if (lenErr) errors.push(lenErr)
    }

    if (errors.length > 0)
      throw new ValidationError("Validation failed", errors)
    next()
  } catch (err) {
    next(err)
  }
}

export function validateLogin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const { username, password } = req.body
    if (!username || !password)
      throw new ValidationError("Username and password are required")
    next()
  } catch (err) {
    next(err)
  }
}

export function validateWeightEntry(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const { weightKg } = req.body
    if (!validatePositiveNumber(weightKg))
      throw new ValidationError("Weight must be a positive number")
    if (weightKg < 20 || weightKg > 500)
      throw new ValidationError("Weight must be between 20-500 kg")
    next()
  } catch (err) {
    next(err)
  }
}

export function validateHeightEntry(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const { heightCm } = req.body
    if (!validatePositiveNumber(heightCm))
      throw new ValidationError("Height must be a positive number")
    if (heightCm < 50 || heightCm > 300)
      throw new ValidationError("Height must be between 50-300 cm")
    next()
  } catch (err) {
    next(err)
  }
}

export function validateSessionCreation(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const { dayNumber, dayTitle, muscleGroups } = req.body
    const errors: string[] = []

    if (!validateInteger(dayNumber) || dayNumber < 1)
      errors.push("Day number must be a positive integer")

    if (!dayTitle?.trim()) {
      errors.push("Day title is required")
    } else {
      const lenErr = checkMaxLength(String(dayTitle), "dayTitle")
      if (lenErr) errors.push(lenErr)
    }

    if (!Array.isArray(muscleGroups))
      errors.push("Muscle groups must be an array")

    if (errors.length > 0)
      throw new ValidationError("Invalid session data", errors)
    next()
  } catch (err) {
    next(err)
  }
}

export function validateSetTiming(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const { exerciseName, setIndex, startTime, endTime, weight, reps, note } =
      req.body
    const errors: string[] = []

    if (
      !exerciseName ||
      typeof exerciseName !== "string" ||
      !exerciseName.trim()
    ) {
      errors.push("Exercise name must be a non-empty string")
    } else {
      const lenErr = checkMaxLength(exerciseName, "exerciseName")
      if (lenErr) errors.push(lenErr)
    }

    if (!validateInteger(setIndex) || setIndex < 0)
      errors.push("Set index must be a non-negative integer")
    if (!validateISODate(startTime)) errors.push("Invalid start time format")
    if (!validateISODate(endTime)) errors.push("Invalid end time format")
    if (weight != null && !validatePositiveNumber(weight))
      errors.push("Weight must be a positive number")
    if (reps != null && (!validateInteger(reps) || reps < 1))
      errors.push("Reps must be a positive integer")

    if (note != null) {
      if (typeof note !== "string") errors.push("Note must be a string")
      else {
        const lenErr = checkMaxLength(note, "note")
        if (lenErr) errors.push(lenErr)
      }
    }

    if (errors.length > 0)
      throw new ValidationError("Invalid set timing data", errors)
    next()
  } catch (err) {
    next(err)
  }
}

/**
 * Validate a PATCH to an existing set. Every field is optional (partial update),
 * but any field that IS supplied must be well-formed — this prevents unvalidated
 * weight/reps/timestamps from reaching the DB via the update path.
 */
export function validateSetTimingUpdate(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const {
      exerciseName,
      muscleGroup,
      weight,
      reps,
      startTime,
      endTime,
      note,
      isWarmup,
    } = req.body
    const errors: string[] = []

    if (exerciseName !== undefined) {
      if (typeof exerciseName !== "string" || !exerciseName.trim())
        errors.push("Exercise name must be a non-empty string")
      else {
        const lenErr = checkMaxLength(exerciseName, "exerciseName")
        if (lenErr) errors.push(lenErr)
      }
    }
    if (muscleGroup != null) {
      if (typeof muscleGroup !== "string") errors.push("Muscle group must be a string")
      else {
        const lenErr = checkMaxLength(muscleGroup, "muscleGroup")
        if (lenErr) errors.push(lenErr)
      }
    }
    if (weight !== undefined && !validatePositiveNumber(weight))
      errors.push("Weight must be a positive number")
    if (reps !== undefined && (!validateInteger(reps) || reps < 1))
      errors.push("Reps must be a positive integer")
    if (startTime !== undefined && !validateISODate(startTime))
      errors.push("Invalid start time format")
    if (endTime !== undefined && !validateISODate(endTime))
      errors.push("Invalid end time format")
    if (note != null) {
      if (typeof note !== "string") errors.push("Note must be a string")
      else {
        const lenErr = checkMaxLength(note, "note")
        if (lenErr) errors.push(lenErr)
      }
    }
    if (isWarmup !== undefined && typeof isWarmup !== "boolean")
      errors.push("isWarmup must be a boolean")

    if (errors.length > 0)
      throw new ValidationError("Invalid set update data", errors)
    next()
  } catch (err) {
    next(err)
  }
}

export function validateProteinIntake(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const { grams, errorMargin, time, takenAt } = req.body
    const errors: string[] = []

    if (!validatePositiveNumber(grams))
      errors.push("Grams must be a positive number")
    if (grams > 500) errors.push("Grams must be less than 500")
    if (
      errorMargin !== undefined &&
      (typeof errorMargin !== "number" || errorMargin < 0 || errorMargin > 100)
    )
      errors.push("Error margin must be between 0-100")

    if (!time) {
      errors.push("Time is required")
    } else {
      const lenErr = checkMaxLength(String(time), "time")
      if (lenErr) errors.push(lenErr)
    }

    if (!validateISODate(takenAt)) errors.push("Invalid taken at date format")

    if (errors.length > 0)
      throw new ValidationError("Invalid protein intake data", errors)
    next()
  } catch (err) {
    next(err)
  }
}

export function validateBodyFatCalculation(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const { waist, neck, unit } = req.body
    const errors: string[] = []

    if (!validatePositiveNumber(waist))
      errors.push("Waist measurement must be a positive number")
    if (!validatePositiveNumber(neck))
      errors.push("Neck measurement must be a positive number")
    if (unit && !validateEnum(unit, ["cm", "in"]))
      errors.push('Unit must be "cm" or "in"')

    if (errors.length > 0)
      throw new ValidationError("Invalid body fat data", errors)
    next()
  } catch (err) {
    next(err)
  }
}

export function validatePagination(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const { page, limit } = req.query
    if (page !== undefined) {
      const n = parseInt(page as string)
      if (!validateInteger(n) || n < 1)
        throw new ValidationError("Page must be a positive integer")
    }
    if (limit !== undefined) {
      const n = parseInt(limit as string)
      if (!validateInteger(n) || n < 1 || n > 100)
        throw new ValidationError("Limit must be between 1-100")
    }
    next()
  } catch (err) {
    next(err)
  }
}
