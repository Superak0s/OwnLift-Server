export interface JwtPayload {
  userId: number
  tokenVersion: number
  /** Seconds since epoch, set by jsonwebtoken from JWT_EXPIRES_IN. */
  exp?: number
}
