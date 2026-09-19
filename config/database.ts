import mysql, { Pool, PoolConnection } from "mysql2/promise";
import fs from "fs";
import path from "path";
import type { RowDataPacket } from "mysql2/promise";
import type { Connection as CoreConnection } from "mysql2";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../middleware/errorHandler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Required environment variable "${name}" is not set`);
  return value;
}

export const pool: Pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: requireEnv("DB_USER"),
  password: requireEnv("DB_PASSWORD"),
  database: requireEnv("DB_NAME"),
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  // Sized for the box this server actually targets: one small, often
  // single-core machine serving its owner plus a few invited friends. Twenty
  // concurrent queries on one core is thrash, not throughput, and every idle
  // connection carries its own MySQL thread buffers and prepared-statement
  // cache. Eight rather than six leaves headroom above the widest fan-out in
  // the codebase (getSorenessStats issues six in parallel); queueLimit absorbs
  // anything past that.
  connectionLimit: 8,
  // Bounded rather than unlimited (0): under a real overload, requests should
  // fail fast with an error the client can retry, not queue indefinitely and
  // pile up memory/timeouts.
  queueLimit: 200,
  dateStrings: true,
  // DECIMAL columns otherwise arrive as strings, so weights and volumes would
  // serialize into JSON quoted and force every client to re-parse them.
  decimalNumbers: true,
});

// Every timestamp this server writes is UTC (see formatDateForMySQL), so the
// connection must read them back as UTC too — otherwise NOW(), CURDATE() and
// the CURRENT_TIMESTAMP column defaults sit at the box's local offset and
// "today" comparisons drift by that many hours. Pinned here rather than left
// to the operator's my.cnf, which usually says SYSTEM.
// Callback form deliberately: pool.on("connection") hands over the *core*
// (callback-style) connection, and a callback-less query there returns a Query
// EventEmitter that does `emit("error", err)` on failure. With no listener that
// throws out of the emitter as an uncaughtException, which shutdown()s the
// process — so a MySQL restart while the pool was opening a connection killed
// the server. Passing a callback routes the error to it instead.
// The typings say PoolConnection (promise flavour); the runtime hands over the
// callback-style core connection, which is the whole point here.
pool.on("connection", (conn) => {
  const connection = conn as unknown as CoreConnection
  connection.query("SET time_zone = '+00:00'", (err) => {
    if (err)
      logger.warn(
        "Could not pin connection time_zone to UTC:",
        (err as Error).message,
      );
  });
});

/**
 * Formats a Date or date string as a MySQL DATETIME string (YYYY-MM-DD HH:MM:SS).
 * Uses UTC methods so the stored value matches UTC regardless of the server's
 * local timezone setting. Ensure MySQL is also configured to use UTC
 * (set time_zone = '+00:00' in my.cnf or via SET GLOBAL time_zone).
 */
export function formatDateForMySQL(date: string | Date): string {
  const d = date instanceof Date ? date : new Date(date)
  // toISOString throws RangeError on an invalid date — an unvalidated client
  // timestamp used to reach the error handler as a 500 for what is a 400.
  if (Number.isNaN(d.getTime()))
    throw new ValidationError(`Invalid timestamp: ${String(date)}`)
  return d.toISOString().slice(0, 19).replace("T", " ")
}

/**
 * Parse a DATETIME the driver handed back. The pool runs with
 * `dateStrings: true` and everything is stored UTC, but "2026-09-08 22:45:33"
 * carries no zone, so a bare `new Date(...)` reads it as local time and shifts
 * it by the machine's offset. Date-only and already-zoned values pass through.
 */
export function parseMySQLDate(value: string | Date): Date {
  if (value instanceof Date) return value
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? new Date(value.replace(" ", "T") + "Z")
    : new Date(value)
}

async function createDatabaseIfNotExists(): Promise<void> {
  const dbName = requireEnv("DB_NAME");
  // Temporary connection for CREATE DATABASE — never log this config object.
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: requireEnv("DB_USER"),
    password: requireEnv("DB_PASSWORD"),
    port: Number(process.env.DB_PORT) || 3306,
  });
  try {
    // DB_NAME is the operator's own, not user input, but an unescaped backtick
    // turns a typo into a confusing syntax error at boot instead of a clear one.
    await connection.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbName.replace(/`/g, "``")}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    logger.info(`✓ Database '${dbName}' verified/created`);
  } finally {
    await connection.end();
  }
}

// Naive: strips comments (including ones inside string literals) and splits on
// every `;`. Correct for schema.sql and every migration here, all of which are
// plain DDL. A statement containing a semicolon in a string, a DELIMITER block,
// a trigger or a stored procedure will be mangled — write those as their own
// file with a real parser, or don't write them.
// ponytail: naive splitter, swap for a real tokenizer only if a migration ever
// needs a semicolon inside a literal.
function parseSQLStatements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Every statement in schema.sql is CREATE TABLE IF NOT EXISTS, so it's safe to
// run on every boot. Further schema changes (new columns, indexes, etc.) go
// through migrations/*.sql rather than edits to schema.sql.

/** True when the database has no tables yet — i.e. schema.sql is about to
 * create everything from scratch, so no migration has anything to do. */
async function isEmptyDatabase(): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()`,
  );
  return Number(rows[0]!.n) === 0;
}

async function initializeTables(): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath}.`);
  }

  const connection: PoolConnection = await pool.getConnection();
  try {
    const statements = parseSQLStatements(fs.readFileSync(schemaPath, "utf8"));
    for (const stmt of statements) {
      if (/^(USE\s|CREATE\s+DATABASE)/i.test(stmt)) continue;
      await connection.execute(stmt);
    }
    logger.info("✓ All database tables initialized successfully");
  } finally {
    connection.release();
  }
}

// For schema changes that CREATE TABLE IF NOT EXISTS can't express (new
// columns, indexes on existing tables). Each file in migrations/ runs at
// most once, tracked in _migrations, in filename order.

// MySQL commits DDL implicitly, so a migration cannot be wrapped in a real
// transaction: if the boot dies between its ALTER and the _migrations insert,
// the change is applied but unrecorded, and every later boot then aborts on
// "Duplicate column name". Statements whose error means "already there" or
// "already gone" count as done.
// ponytail: covers add/drop of columns and indexes, which is every migration
// so far. Add codes here if a future migration needs another shape.
const ALREADY_APPLIED = new Set([
  "ER_DUP_FIELDNAME", // ADD COLUMN, column exists
  "ER_DUP_KEYNAME", // ADD INDEX, index exists
  "ER_CANT_DROP_FIELD_OR_KEY", // DROP COLUMN/INDEX, already gone
]);

async function runMigrations(isFresh: boolean): Promise<void> {
  const migrationsDir = path.join(__dirname, "..", "migrations");
  if (!fs.existsSync(migrationsDir)) return;

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       VARCHAR(255) NOT NULL,
      applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  // schema.sql always describes the *current* shape, so a database created in
  // this run is already past every migration. Running them anyway fails on
  // columns that no longer exist (renames, drops) or already do (adds), so
  // stamp them as applied instead.
  if (isFresh) {
    for (const file of files)
      await pool.execute(`INSERT INTO _migrations (name) VALUES (?)`, [file]);
    logger.info(`✓ Fresh database — marked ${files.length} migrations applied`);
    return;
  }

  for (const file of files) {
    const [applied] = await pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM _migrations WHERE name = ?`,
      [file],
    );
    if (applied.length > 0) continue;

    const statements = parseSQLStatements(
      fs.readFileSync(path.join(migrationsDir, file), "utf8"),
    );
    const connection = await pool.getConnection();
    try {
      for (const stmt of statements) {
        try {
          await connection.execute(stmt);
        } catch (err) {
          if (ALREADY_APPLIED.has((err as { code?: string }).code ?? "")) continue;
          // Without the filename the operator sees a bare MySQL error from a
          // box that won't boot, and no hint that a migration was even running.
          throw new Error(
            `migration ${file} failed on "${stmt.slice(0, 120)}": ${(err as Error).message}`,
            { cause: err },
          );
        }
      }
      await connection.execute(`INSERT INTO _migrations (name) VALUES (?)`, [
        file,
      ]);
      logger.info(`✓ Applied migration ${file}`);
    } finally {
      connection.release();
    }
  }
}

export async function testDatabaseConnection(): Promise<void> {
  try {
    await createDatabaseIfNotExists();
    const connection = await pool.getConnection();
    logger.info("✓ Database connected successfully");
    connection.release();
    const isFresh = await isEmptyDatabase();
    await initializeTables();
    await runMigrations(isFresh);
    logger.info("✓ Database is ready");
  } catch (error) {
    // Log only the message — never the error object itself as it may contain
    // credentials from the pool config in certain mysql2 error shapes.
    logger.error(
      "✗ Database initialization failed:",
      (error as Error).message,
    );
    process.exit(1);
  }
}
