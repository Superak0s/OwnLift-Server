-- Geofenced supplement reminders were never wired up in the app: nothing ever
-- called PUT/GET /api/tracking/supplements/:id/location, so the table and the
-- mirrored flag on supplements only ever held defaults.
DROP TABLE IF EXISTS supplement_locations;
ALTER TABLE supplements DROP COLUMN location_reminder_enabled;
