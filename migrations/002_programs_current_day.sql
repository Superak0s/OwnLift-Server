-- Adds programs.current_day, the server-side "which day is the user on"
-- pointer, for deployments whose table predates it (schema.sql's
-- CREATE TABLE IF NOT EXISTS only helps fresh databases). NULL means the user
-- has never set one. Minimum supported prior version: any post-rename
-- (workouts/set-based) schema.
ALTER TABLE programs
  ADD COLUMN current_day INT UNSIGNED DEFAULT NULL AFTER split_order;
