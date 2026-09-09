import { Request, Response, NextFunction } from "express"
import { ValidationError } from "./errorHandler.js"

// Prevents oversized strings from passing body-size checks and being stored.
// Values match the DB column sizes in config/schema.sql.
//
// These all throw synchronously; Express 5 forwards a thrown error to the
// error handler on its own, so none of them need a try/catch + next(err).

const MAX_LENGTHS = {
  username: 20,
  email: 255,
  password: 128,
  name: 128,
  dayTitle: 255,
  exerciseName: 255,
  note: 1000,
  time: 8,
  machineName: 100,
} as const

const MUSCLE_NAME_MAX = 128

/**
 * Parse a path param / body field that must be an integer id, rejecting
 * anything else with a 400 naming the field. Ids are auto-increment columns,
 * so zero and negatives are as invalid as non-numbers.
 */
export function parseIntParam(value: string, name: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 1) throw new ValidationError(`Invalid ${name}`)
  return n
}

/**
 * Read a caller-supplied `?limit=` (or another numeric query key), falling
 * back to a default and clamping to a ceiling so a client can't ask for an
 * unbounded result set.
 */
export function queryLimit(
  req: Request,
  { def, max, key = "limit" }: { def: number; max: number; key?: string },
): number {
  return Math.min(parseInt(req.query[key] as string, 10) || def, max)
}

const validateEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
const validateUsername = (v: string) => /^[a-zA-Z0-9_]{3,20}$/.test(v)
// Require at least one letter and one digit alongside the length floor —
// blocks purely-numeric or purely-alphabetic weak passwords without forcing
// symbol/case gymnastics on users.
const validatePassword = (v: string) =>
  !!v && v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v)
const validatePositiveNumber = (v: unknown): v is number =>
  typeof v === "number" && v > 0 && !isNaN(v)
const validateInteger = (v: unknown): v is number => Number.isInteger(v)
const validateISODate = (v: string) => !isNaN(new Date(v).getTime())

/**
 * Read an optional client-supplied timestamp for an entry the user is
 * backdating to an earlier day, returning null when none was sent.
 *
 * Clients send a timezone-less local stamp (a calendar day-tap defaults to
 * 09:00 that day), so an entry logged early in the morning — or from a phone
 * ahead of a UTC-running box — can read as slightly future here. Hence a day
 * of slack instead of a strict `> now`: it still catches a typo'd year.
 */
export function parseBackdatedTimestamp(
  value: unknown,
  field: string,
): string | null {
  if (value == null) return null
  if (typeof value !== "string" || !validateISODate(value))
    throw new ValidationError(`${field} must be an ISO-8601 date`)
  if (new Date(value).getTime() > Date.now() + 24 * 60 * 60 * 1000)
    throw new ValidationError(`${field} cannot be in the future`)
  return value
}

function checkMaxLength(
  value: string,
  field: keyof typeof MAX_LENGTHS,
): string | null {
  const limit = MAX_LENGTHS[field]
  return value.length > limit
    ? `${field} must not exceed ${limit} characters`
    : null
}

/**
 * Check an optional muscle-group array (primaryMuscles / secondaryMuscles):
 * an array of non-empty strings, each capped like the old single-group field.
 */
function checkMuscleArray(
  value: unknown,
  field: "primaryMuscles" | "secondaryMuscles",
  errors: string[],
): void {
  if (value == null) return
  const ok =
    Array.isArray(value) &&
    value.every(
      (g) =>
        typeof g === "string" && !!g.trim() && g.length <= MUSCLE_NAME_MAX,
    )
  if (!ok)
    errors.push(
      `${field} must be an array of non-empty strings (max ${MUSCLE_NAME_MAX} chars each)`,
    )
}

/** Reject requests that are missing any of the listed body fields. */
export function validateRequired(requiredFields: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const missing = requiredFields.filter(
      (f) =>
        req.body[f] === undefined || req.body[f] === null || req.body[f] === "",
    )
    if (missing.length > 0) {
      throw new ValidationError(`Missing required fields: ${missing.join(", ")}`)
    }
    next()
  }
}

export function validateRegistration(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
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
      errors.push(
        "Password must be at least 8 characters and contain a letter and a number",
      )
    const lenErr = checkMaxLength(password, "password")
    if (lenErr) errors.push(lenErr)
  }

  if (errors.length > 0) throw new ValidationError("Validation failed", errors)
  next()
}

export function validatePasswordChange(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const { currentPassword, newPassword } = req.body
  const errors: string[] = []

  if (!currentPassword) errors.push("Current password is required")

  if (!newPassword) {
    errors.push("New password is required")
  } else {
    if (!validatePassword(newPassword))
      errors.push(
        "New password must be at least 8 characters and include a letter and a number",
      )
    const lenErr = checkMaxLength(newPassword, "password")
    if (lenErr) errors.push(lenErr)
  }

  if (errors.length > 0) throw new ValidationError("Validation failed", errors)
  next()
}

export function validateProfileUpdate(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const { name, email, heightCm } = req.body
  const errors: string[] = []

  // Range is enforced again in updateUserProfile, which is the only writer.
  if (heightCm !== undefined) {
    const h = Number(heightCm)
    if (!Number.isFinite(h) || h <= 0 || h > 300)
      errors.push("Height must be between 1-300 cm")
  }

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      errors.push("Name must be a non-empty string")
    } else {
      const lenErr = checkMaxLength(name, "name")
      if (lenErr) errors.push(lenErr)
    }
  }

  if (email !== undefined) {
    if (typeof email !== "string" || !validateEmail(email)) {
      errors.push("Invalid email format")
    } else {
      const lenErr = checkMaxLength(email, "email")
      if (lenErr) errors.push(lenErr)
    }
  }

  if (errors.length > 0) throw new ValidationError("Validation failed", errors)
  next()
}

export function validateLogin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const { username, password } = req.body
  if (!username || !password)
    throw new ValidationError("Username and password are required")
  next()
}

export function validateWeightEntry(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const { weightKg } = req.body
  if (!validatePositiveNumber(weightKg))
    throw new ValidationError("Weight must be a positive number")
  if (weightKg < 20 || weightKg > 500)
    throw new ValidationError("Weight must be between 20-500 kg")
  next()
}

export function validateSessionCreation(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const { dayNumber, dayTitle, primaryMuscles, secondaryMuscles } = req.body
  const errors: string[] = []

  if (!validateInteger(dayNumber) || dayNumber < 1)
    errors.push("Day number must be a positive integer")

  if (!dayTitle?.trim()) {
    errors.push("Day title is required")
  } else {
    const lenErr = checkMaxLength(String(dayTitle), "dayTitle")
    if (lenErr) errors.push(lenErr)
  }

  checkMuscleArray(primaryMuscles, "primaryMuscles", errors)
  checkMuscleArray(secondaryMuscles, "secondaryMuscles", errors)

  if (errors.length > 0)
    throw new ValidationError("Invalid session data", errors)
  next()
}

/**
 * Validate the fields of a set timing. Every field is checked only if it is
 * present, so this serves both the create and the partial-update path — the
 * create route runs `validateRequired` ahead of it to demand the mandatory
 * ones. Any field that IS supplied must be well-formed, which is what keeps
 * unvalidated weight/reps/timestamps from reaching the DB via either path.
 */
export function validateSetTiming(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const {
    exerciseName,
    primaryMuscles,
    secondaryMuscles,
    setIndex,
    startTime,
    endTime,
    weight,
    reps,
    note,
    isWarmup,
    machineName,
    rpe,
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
  checkMuscleArray(primaryMuscles, "primaryMuscles", errors)
  checkMuscleArray(secondaryMuscles, "secondaryMuscles", errors)
  if (setIndex !== undefined && (!validateInteger(setIndex) || setIndex < 0))
    errors.push("Set index must be a non-negative integer")
  if (startTime !== undefined && !validateISODate(startTime))
    errors.push("Invalid start time format")
  if (endTime !== undefined && !validateISODate(endTime))
    errors.push("Invalid end time format")
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
  if (isWarmup !== undefined && typeof isWarmup !== "boolean")
    errors.push("isWarmup must be a boolean")
  // null clears a previous rating; absent leaves it alone. Never coerced to 0.
  if (rpe != null && (!validateInteger(rpe) || rpe < 1 || rpe > 10))
    errors.push("rpe must be an integer between 1 and 10")
  // Free text from the user — only the column width matters.
  if (machineName != null) {
    if (typeof machineName !== "string")
      errors.push("machineName must be a string")
    else {
      const lenErr = checkMaxLength(machineName, "machineName")
      if (lenErr) errors.push(lenErr)
    }
  }

  if (errors.length > 0)
    throw new ValidationError("Invalid set timing data", errors)
  next()
}
