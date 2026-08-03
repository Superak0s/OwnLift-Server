// src/config/database.ts
import mysql, { Pool, PoolConnection } from "mysql2/promise";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import type { QueryResult, FieldPacket } from "mysql2/promise";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

// ─── Fail fast if critical env vars are missing ───────────────────────────────
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Required environment variable "${name}" is not set`);
  return value;
}

// ─── Pool config ──────────────────────────────────────────────────────────────
// Credentials are kept in a closure-scoped object and never assigned to a
// variable that could be accidentally logged.
function getPoolConfig() {
  return {
    host: process.env.DB_HOST || "localhost",
    user: requireEnv("DB_USER"),
    password: requireEnv("DB_PASSWORD"),
    database: requireEnv("DB_NAME"),
    port: Number(process.env.DB_PORT) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
  };
}

export const pool: Pool = mysql.createPool(getPoolConfig());

// Safe subset of connection info — no passwords, no credentials.
// Use this wherever you need to log or surface DB info to callers.
export interface DatabaseInfo {
  host: string;
  port: number | string;
  database: string;
  user: string;
}

/** Typed wrapper — avoids casting `params` to `any` at every call-site. */
export function query<T extends QueryResult>(
  sql: string,
  params?: unknown[],
): Promise<[T, FieldPacket[]]> {
  return pool.execute<T>(sql, params as any);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

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
    console.log(`✓ Database '${dbName}' verified/created`);
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

// ─── Schema migration guard ───────────────────────────────────────────────────
//
// schema.sql is applied ONCE on a brand-new database (version = 0).
// For any subsequent schema changes (new columns, indexes, etc.) you MUST
// write a proper migration rather than editing schema.sql, because this guard
// will NOT re-run schema.sql once the DB is at version 1.
//
// Recommended migration tools: db-migrate, Knex migrations, or a simple
// numbered SQL files runner.  Bump CURRENT_SCHEMA_VERSION and add a migration
// step for every additive change.

const CURRENT_SCHEMA_VERSION = 1;

async function getSchemaVersion(connection: PoolConnection): Promise<number> {
  try {
    await connection.execute(
      `CREATE TABLE IF NOT EXISTS _schema_version (
         version INT NOT NULL DEFAULT 0,
         applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB`,
    );
    const [rows] = await connection.execute<any[]>(
      "SELECT version FROM _schema_version ORDER BY applied_at DESC LIMIT 1",
    );
    return rows[0]?.version ?? 0;
  } catch {
    return 0;
  }
}

async function setSchemaVersion(
  connection: PoolConnection,
  version: number,
): Promise<void> {
  await connection.execute("INSERT INTO _schema_version (version) VALUES (?)", [
    version,
  ]);
}

export async function initializeTables(): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath}.`);
  }

  const connection: PoolConnection = await pool.getConnection();
  try {
    const currentVersion = await getSchemaVersion(connection);

    if (currentVersion >= CURRENT_SCHEMA_VERSION) {
      console.log(`✓ Schema is up to date (version ${currentVersion})`);
      return;
    }

    // If DB is brand-new, apply schema.sql normally.
    if (currentVersion === 0) {
      console.log(
        `🔧 Running schema.sql (upgrading from v${currentVersion} → v${CURRENT_SCHEMA_VERSION})…`,
      );
      const statements = parseSQLStatements(
        fs.readFileSync(schemaPath, "utf8"),
      );
      for (const stmt of statements) {
        if (/^(USE\s|CREATE\s+DATABASE)/i.test(stmt)) continue;
        await connection.execute(stmt);
      }
      await setSchemaVersion(connection, CURRENT_SCHEMA_VERSION);
      console.log("✓ All database tables initialized successfully");
      return;
    }

    console.log(
      `✓ Database schema upgraded to version ${CURRENT_SCHEMA_VERSION}`,
    );
  } finally {
    connection.release();
  }
}

async function ensureAdditionalTrackingTables(): Promise<void> {
  // Create tables that were added after initial schema versioning. Using
  // CREATE TABLE IF NOT EXISTS keeps this idempotent and safe to run on an
  // existing database.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS muscle_soreness (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      muscle_group VARCHAR(128) NOT NULL,
      intensity TINYINT NOT NULL,
      logged_at DATETIME NOT NULL,
      note TEXT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ms_user_date (user_id, logged_at),
      CONSTRAINT fk_ms_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS menstrual_cycle (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      cycle_start DATETIME NOT NULL,
      cycle_end DATETIME DEFAULT NULL,
      duration_days INT DEFAULT NULL,
      flow_intensity ENUM('light','moderate','heavy') DEFAULT 'moderate',
      symptoms TEXT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_mc_user_start (user_id, cycle_start),
      CONSTRAINT fk_mc_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ─── Active DOMS (soreness with follow-ups) ──────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS active_soreness (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      muscle_group VARCHAR(128) NOT NULL,
      intensity TINYINT NOT NULL,
      notes TEXT DEFAULT NULL,
      logged_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      recovered_at DATETIME DEFAULT NULL,
      status ENUM('active','recovering','recovered') NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_as_user_status (user_id, status),
      KEY idx_as_user_muscle (user_id, muscle_group),
      CONSTRAINT fk_as_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS soreness_follow_up (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      soreness_id INT UNSIGNED NOT NULL,
      intensity TINYINT NOT NULL,
      status ENUM('still_sore','better','recovered') NOT NULL,
      notes TEXT DEFAULT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sf_soreness (soreness_id),
      CONSTRAINT fk_sf_soreness FOREIGN KEY (soreness_id) REFERENCES active_soreness (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ─── Injury tracking ─────────────────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS injuries (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      muscle_group VARCHAR(128) NOT NULL,
      injury_type ENUM('strain','sprain','tendonitis','fracture','dislocation','tear','overuse','surgery','other') NOT NULL,
      pain_level TINYINT NOT NULL,
      start_date DATETIME NOT NULL,
      recovery_date DATETIME DEFAULT NULL,
      notes TEXT DEFAULT NULL,
      status ENUM('active','recovering','recovered') NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_inj_user_status (user_id, status),
      KEY idx_inj_user_muscle (user_id, muscle_group),
      CONSTRAINT fk_inj_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ─── Progress photos with muscle tags ────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS progress_photos_muscle (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      uri VARCHAR(1024) NOT NULL,
      taken_at DATETIME NOT NULL,
      notes TEXT DEFAULT NULL,
      angle ENUM('front','back','side','custom') NOT NULL DEFAULT 'custom',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ppm_user_taken (user_id, taken_at),
      CONSTRAINT fk_ppm_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS progress_photos_muscle_tags (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      photo_id INT UNSIGNED NOT NULL,
      muscle_group VARCHAR(128) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ppmt_photo (photo_id),
      KEY idx_ppmt_muscle (muscle_group),
      CONSTRAINT fk_ppmt_photo FOREIGN KEY (photo_id) REFERENCES progress_photos_muscle (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ─── Personal muscle notes ───────────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS personal_muscle_notes (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      muscle_group VARCHAR(128) NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_pmn_user_muscle (user_id, muscle_group),
      CONSTRAINT fk_pmn_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function testDatabaseConnection(): Promise<void> {
  try {
    await createDatabaseIfNotExists();
    const connection = await pool.getConnection();
    console.log("✓ Database connected successfully");
    connection.release();
    await initializeTables();
    // Ensure any newer/additional tracking tables exist even if the DB was
    // already initialized with an older schema version.
    await ensureAdditionalTrackingTables();
    console.log("✓ Database is ready");
  } catch (error) {
    // Log only the message — never the error object itself as it may contain
    // credentials from the pool config in certain mysql2 error shapes.
    console.error(
      "✗ Database initialization failed:",
      (error as Error).message,
    );
    process.exit(1);
  }
}

export function getDatabaseInfo(): DatabaseInfo {
  return {
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT || 3306,
    database: process.env.DB_NAME || "(unset)",
    user: process.env.DB_USER || "(unset)",
  };
}
