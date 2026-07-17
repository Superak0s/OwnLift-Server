/**
 * types/auth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Authentication-related shapes shared across the HTTP and WebSocket layers.
 */

/** Decoded JWT payload issued at sign-in. */
export interface JwtPayload {
  userId: number
}
