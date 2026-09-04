-- The generic single muscle-group field becomes a primary/secondary pair of
-- JSON arrays on both exercises and sessions, matching the app's shape.
ALTER TABLE exercises
  ADD COLUMN primary_muscles JSON DEFAULT NULL AFTER name,
  ADD COLUMN secondary_muscles JSON DEFAULT NULL AFTER primary_muscles;
UPDATE exercises
  SET primary_muscles = JSON_ARRAY(muscle_group)
  WHERE muscle_group IS NOT NULL AND TRIM(muscle_group) <> '';
UPDATE exercises SET secondary_muscles = JSON_ARRAY() WHERE secondary_muscles IS NULL;
ALTER TABLE exercises DROP COLUMN muscle_group;

-- Values are copied as-is: array rows stay arrays, and the legacy plain-string
-- rows are normalized at read time by parseMuscleGroups.
ALTER TABLE sessions
  ADD COLUMN primary_muscles JSON DEFAULT NULL AFTER day_title,
  ADD COLUMN secondary_muscles JSON DEFAULT NULL AFTER primary_muscles;
UPDATE sessions SET primary_muscles = muscle_groups WHERE muscle_groups IS NOT NULL;
UPDATE sessions SET secondary_muscles = JSON_ARRAY() WHERE secondary_muscles IS NULL;
ALTER TABLE sessions DROP COLUMN muscle_groups;
