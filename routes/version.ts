// routes/version.ts
import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router: Router = Router();

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(versionString: string): ParsedVersion {
  const parts = versionString.split(".");
  return {
    major: parseInt(parts[0] || "0", 10),
    minor: parseInt(parts[1] || "0", 10),
    patch: parseInt(parts[2] || "0", 10),
  };
}

/**
 * GET /api/version
 *
 * Auth-gated: exposes the exact server version which could be used to
 * target known CVEs. Only authenticated users (e.g. the app itself after
 * sign-in) should see this.
 */
router.get("/", (req: Request, res: Response) => {
  try {
    const packageJsonPath = path.resolve(__dirname, "../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const version: string = packageJson.version || "0.0.0";

    res.json({
      success: true,
      version,
      parsed: parseVersion(version),
    });
  } catch (error) {
    console.error("❌ Error reading version:", (error as Error).message);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve server version",
      version: "0.0.0",
      parsed: { major: 0, minor: 0, patch: 0 },
    });
  }
});

export default router;
