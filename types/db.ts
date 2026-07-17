/**
 * types/db.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared database result shapes. Previously each model re-declared its own
 * `InsertResult` — this is the single canonical definition.
 */
import type { ResultSetHeader } from "mysql2"

/** Result of an INSERT/UPDATE/DELETE via mysql2, with the fields we actually read. */
export interface InsertResult extends ResultSetHeader {
  insertId: number
  affectedRows: number
}
