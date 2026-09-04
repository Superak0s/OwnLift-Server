-- Lets the client tag a session as demo data at creation time, so "Remove
-- Demo Data" in online mode has something to find and delete.
ALTER TABLE sessions ADD COLUMN is_demo TINYINT(1) NOT NULL DEFAULT 0 AFTER completed_sets;
