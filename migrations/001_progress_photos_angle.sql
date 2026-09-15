-- Adds angle/custom_side_name to progress_photos for deployments whose table
-- predates those columns (schema.sql's CREATE TABLE IF NOT EXISTS only helps
-- fresh databases). Minimum supported prior version: any post-rename
-- (workouts/set-based) schema.
ALTER TABLE progress_photos
  ADD COLUMN angle ENUM('front','back','side','custom') NOT NULL DEFAULT 'custom' AFTER note;

ALTER TABLE progress_photos
  ADD COLUMN custom_side_name VARCHAR(255) DEFAULT NULL AFTER angle;
