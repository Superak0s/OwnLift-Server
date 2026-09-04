import { fileURLToPath } from "node:url"

// Runs before every test file's imports in each worker.
// Set overrides first so loadEnvFile (which never clobbers existing vars)
// only fills in DB creds from the real .env.
process.env.DB_NAME = "ownlift_test"
process.env.JWT_SECRET = "test-jwt-secret-0123456789-0123456789"
process.env.ALLOWED_ORIGINS = "http://localhost:3000"
process.env.NODE_ENV = "development"
delete process.env.PORT

const envPath = fileURLToPath(new URL("../.env", import.meta.url))
process.loadEnvFile(envPath)

