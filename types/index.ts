/**
 * types/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Barrel for every domain type. Import from here ("../types") — the concrete
 * declarations live in the per-domain files below and are re-exported so
 * callers keep a single import entry point.
 */

export * from "./db.js"
export * from "./auth.js"
export * from "./user.js"
export * from "./program.js"
export * from "./workout.js"
export * from "./analytics.js"
export * from "./tracking.js"
export * from "./social.js"
export * from "./supplements.js"
