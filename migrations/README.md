# Migrations

This directory is intentionally empty.

`config/schema.sql` is the single source of truth: it describes the *current*
shape of every table and re-runs idempotently on every boot, so a fresh
database is always up to date.

The former `001`–`012` files (deleted) and the uncommitted `013`–`015` files
(found only in `dist/`) are stale with respect to that schema: they target the
pre-rename table names `sessions` / `set_timings` / `supplement_log`, and
`013` even drops `progress_photos`, which the current schema uses for muscle
photos. Running any of them against a current deployment fails at boot or
destroys live data, so they are not restored.

Consequence: a deployment whose database predates the
`sessions` → `workouts` rename cannot be brought current by migrations and
must be re-created (export first via `GET /api/auth/account/export`, then
restore).
New *tables* still go straight into `schema.sql`; if you ever need to alter an
existing table on live boxes again, resume this directory with a fresh
`NNN_description.sql` that targets the current table names, and note the
minimum supported prior version here.

`001_progress_photos_angle.sql` adds `progress_photos.angle` and
`custom_side_name` for deployments created before those columns were added to
`schema.sql`. Minimum supported prior version: any post-rename (`workouts`)
schema.
