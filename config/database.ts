import mysql, { Pool, PoolConnection } from "mysql2/promise";
import fs from "fs";
import path from "path";
import type { RowDataPacket } from "mysql2/promise";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { logger } from "../utils/logger.js";

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
  connectionLimit: 20,
  // Bounded rather than unlimited (0): under a real overload, requests should
  // fail fast with an error the client can retry, not queue indefinitely and
  // pile up memory/timeouts.
  queueLimit: 200,
  dateStrings: true,
  // DECIMAL columns otherwise arrive as strings, so weights and volumes would
  // serialize into JSON quoted and force every client to re-parse them.
  decimalNumbers: true,
});

/**
 * Formats a Date or date string as a MySQL DATETIME string (YYYY-MM-DD HH:MM:SS).
 * Uses UTC methods so the stored value matches UTC regardless of the server's
 * local timezone setting. Ensure MySQL is also configured to use UTC
 * (set time_zone = '+00:00' in my.cnf or via SET GLOBAL time_zone).
 */
export function formatDateForMySQL(date: string | Date): string {
  const d = date instanceof Date ? date : new Date(date)
  return d.toISOString().slice(0, 19).replace("T", " ")
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
    await connection.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    logger.info(`✓ Database '${dbName}' verified/created`);
  } finally {
    await connection.end();
  }
}

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
      await connection.beginTransaction();
      for (const stmt of statements) {
        await connection.execute(stmt);
      }
      await connection.execute(`INSERT INTO _migrations (name) VALUES (?)`, [
        file,
      ]);
      await connection.commit();
      logger.info(`✓ Applied migration ${file}`);
    } catch (err) {
      await connection.rollback();
      throw err;
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
