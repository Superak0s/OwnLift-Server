/**
 * types/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Barrel for every domain type. Import from here ("../types") — the concrete
 * declarations live in the per-domain files below and are re-exported so
 * callers keep a single import entry point.
 */

export * from "./db"
export * from "./auth"
export * from "./user"
export * from "./program"
export * from "./workout"
export * from "./analytics"
export * from "./tracking"
export * from "./social"
export * from "./supplements"
