-- sessions.is_admin flagged demo/admin sessions, but the app never sent it on
-- POST /api/sessions/start, so every row was 0 and the flag (plus its index and
-- the DELETE /api/sessions/admin route it backed) only ever no-oped.
ALTER TABLE sessions DROP KEY idx_sessions_user_admin;
ALTER TABLE sessions DROP COLUMN is_admin;
