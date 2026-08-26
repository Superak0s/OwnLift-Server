-- A program column is a training split (e.g. "PPL" / "Full Body" / "Injury"),
-- not a "person". Rename the session column to match so API responses
-- (SELECT s.*) carry the new spelling.
ALTER TABLE sessions RENAME COLUMN person TO `split`;
