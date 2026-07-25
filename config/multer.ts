// src/config/multer.ts
import multer, { StorageEngine, FileFilterCallback } from "multer";
import path from "path";
import fs from "fs";
import { Request } from "express";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Allowed spreadsheet MIME types (defence-in-depth alongside extension check)
const ALLOWED_MIMES = new Set([
  "application/vnd.oasis.opendocument.spreadsheet", // .ods
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
  // Some clients send generic binary for .ods / .xls
  "application/octet-stream",
]);

const ALLOWED_EXTENSIONS = new Set([".ods", ".xlsx", ".xls"]);

// Use an absolute path anchored to this file's directory, not process.cwd()
const UPLOAD_DIR = path.resolve(__dirname, "../../uploads");

const storage: StorageEngine = multer.diskStorage({
  destination: (_req: Request, _file: Express.Multer.File, cb) => {
    if (!fs.existsSync(UPLOAD_DIR))
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (_req: Request, file: Express.Multer.File, cb) => {
    // Sanitise the original filename — strip path separators and null bytes
    const safe = file.originalname.replace(/[/\\?%*:|"<>\x00]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB hard cap
    files: 1, // one file per request
  },
  fileFilter: (
    _req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback,
  ) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error("Only .ods, .xlsx, and .xls files are allowed"));
    }

    // MIME check — octet-stream is permitted as a fallback because some
    // browsers / OS combinations don't populate a specific spreadsheet MIME.
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return cb(new Error(`Unexpected MIME type: ${file.mimetype}`));
    }

    cb(null, true);
  },
});

export default upload;
