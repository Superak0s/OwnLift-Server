# OwnLift Server

The optional backend for the [OwnLift](../OwnLift-App) fitness app. It provides cross-device sync, user accounts, and real-time social features (friends, joint workouts, live spectating).

> **The OwnLift app does not require this server** — it runs fully offline out of the box. Run this only if you want to sync across devices or enable social/live features, either via the official instance or your own self-hosted one.

A Node.js / TypeScript REST + WebSocket API, backed by MySQL, Docker-first and self-hostable. Every user self-hosts their own instance: one box, one person plus whoever they invite — never a multi-tenant service.

---

## Tech stack

- **Runtime:** Node.js (Docker image `node:24-alpine`), **TypeScript 7**, compiled with `tsc` (+ `tsc-alias` for the `@/*` path alias), run via `tsx watch` in dev.
- **Framework:** **Express 5**.
- **Database:** **MySQL** via `mysql2` (`mysql2/promise` connection pool). No ORM — hand-written SQL with an idempotent `schema.sql` plus numbered migrations.
- **Auth:** **JWT** access tokens (`jsonwebtoken`, HS256) + opaque rotating refresh tokens, **bcryptjs** (12 salt rounds) for password hashing.
- **Real-time:** **WebSockets** (`ws`).
- **Uploads:** **multer** (memory storage for photos; magic-byte checked, stored as LONGBLOB).
- **Security:** `helmet`, `cors`, `express-rate-limit`.
- **Compression:** `compression` — gzip on JSON responses over 1 kb (already-compressed types like photo BLOBs are skipped).
- **Discovery:** `bonjour-service` — the server advertises itself on the LAN as `_ownlift._tcp`.
- **Tests:** **vitest** + `supertest` against a real MySQL (`pnpm test`).
- **Package manager:** **pnpm**.

---

## Architecture

Request pipeline (`server.ts`): `helmet` (CSP `default-src 'none'` — pure JSON API) → `cors` (locked to `ALLOWED_ORIGINS`) → `compression` (gzip, 1 kb threshold) → per-request UUID + logger → rate limiters → `express.json` (50 kb; `/api/program/upload` and `/api/sharing/permissions` get a 2 MB parser mounted first, behind `authenticateToken`) → `GET /healthz` → routes → 404 → global error handler. Body parsing sits *after* the rate limiters, and the 2 MB parser behind auth, so a flood is rejected before the server pays to buffer and parse the payload.

- **Fails fast** on boot if `JWT_SECRET` is missing/`<32` chars, `ALLOWED_ORIGINS` is unset or contains `*`, `TRUST_PROXY_HOPS` is not a non-negative integer, or `LOCAL_ONLY_FEATURES` names an unknown feature.
- **Rate limits:** `/api/auth` = 20 req / 15 min; `/api` = 200 req / 60 s.
- **Feature-first layout:** code lives in `features/<domain>/<name>.{routes,model,types}.ts`; every router is mounted in `routes.ts`.
- `GET /healthz` is unauthenticated, outside the `/api` limiters, and reports `{ status, fqdn, localOnlyFeatures }` — `503 DOWN` if a cached (5 s) `SELECT 1` against MySQL fails.
- On startup: tests the DB connection, auto-provisions the database + schema and runs pending migrations, starts the WebSocket server and the stale-session cleanup job, advertises over mDNS, and listens on `PORT` (default 5000). Graceful shutdown on SIGTERM/SIGINT/unhandled rejection.

---

## API

All routes are under `/api` and require a JWT `Authorization: Bearer <token>` unless noted.

### Auth — `/api/auth`

| Method | Path            | Purpose                                                         |
| ------ | --------------- | --------------------------------------------------------------- |
| POST   | `/signup`       | Register (first-ever user auto-becomes admin); returns tokens   |
| POST   | `/signin`       | Login by username or email; returns access + refresh token      |
| GET    | `/me`           | Current user                                                    |
| PUT    | `/profile`      | Update profile (name, email, height/units, body-fat formula sex) |
| PUT    | `/password`     | Change password (bumps `token_version`, signing out every device) |
| DELETE | `/account/data` | Wipe all user data (confirm `DELETE_ALL_DATA`); keeps account   |
| DELETE | `/account`      | Delete the account and everything it owns (re-checks password)  |
| GET    | `/account/export` | Everything held about the caller as JSON (photo bytes omitted) |
| POST   | `/refresh`      | **Unauthenticated.** Spend a refresh token for a new access token + a rotated refresh token. Reuse of a spent token kills the whole token family (`REFRESH_REUSED`). Falls back to refreshing a still-valid access token for pre-refresh-token app builds |
| POST   | `/signout`      | Revoke the presented refresh token, or every one the user holds with `allDevices: true`. Always `204` |

### Sessions (workouts) — `/api/sessions`

`GET /` (history) · `POST /start` · `POST /:sessionId/set` (record a set; pushes live WS updates) · `PATCH /:sessionId/sets/:setId` (edit a set) · `POST /:sessionId/end` · `GET /:sessionId` · `POST /rename-exercise` (bulk rename across a split's history) · `DELETE /demo` · `DELETE /split/:split` · `DELETE /:sessionId/sets`.

### Program — `/api/program`

`GET /` · `POST /upload` (persist client-parsed program JSON, 2 MB cap) · `DELETE /` · `GET`/`PUT /current-day` · `PATCH /exercise/{rename,add,sets,machine}`. Program spreadsheets are parsed **client-side**; the server only validates the JSON and unpacks it into `programs`/`program_days`/`program_exercises`, rebuilding the same shape on read.

### Analytics / Version

`GET /api/analytics` — totals for the caller: session count, sets completed, volume, first/last session. Filters: `?split=`, `?dayNumber=`, `?days=` (default 365, max 3650).
`GET /api/version` — the running version; **authenticated**, since an exact version is a targeting aid.
An unauthenticated `GET /healthz` liveness probe is served outside `/api`.

### Trainer mode

Send `X-Trainee-Id: <userId>` with an active `trainer` sharing grant and `req.user` is swapped to the trainee for that request; the actor is kept aside for WS events. Mounted on the **sessions, program and analytics** routers only — `/api/auth` never sees it, so a trainer can't touch a trainee's account. What a trainer may do is additive: recording and editing sets, starting and ending workouts, `PATCH /exercise/{add,sets,machine}` and `PUT /current-day`. Every destructive route (all deletes, `POST /program/upload`, `POST /sessions/rename-exercise`, `PATCH /program/exercise/rename`) is guarded by `denyTrainer` and answers 403.

### Tracking — `/api/tracking/*`

- **`bodystats`** — weight log (`POST`/`GET /weight`, `GET /weight/current`, `DELETE /weight/:id`) and body fat (`POST`/`GET /bodyfat/log`, `DELETE /bodyfat/log/:id`) with the US-Navy calculation.
- **`measurements`** — every scalar metric, built-in or user-defined: `POST /` (a map of metric → value), `GET /?metrics=a,b`, `GET`/`POST /definitions`, `DELETE /:id`. `bodystats` and `hydration` are thin routers over it.
- **`hydration`** — `POST /`, `GET /`, `DELETE /:id`.
- **`soreness`** — `POST`/`GET /`, `GET /active`, `GET /stats`, `GET /muscle/:muscle`, `POST /:id/follow-ups`, `DELETE /:id`.
- **`menstrual`** — `POST`/`GET /`, `GET /stats`, `PATCH`/`DELETE /:id`.
- **`injuries`** — `POST`/`GET /`, `GET /active`, `GET /muscle/:muscle`, `PATCH`/`DELETE /:id`.
- **`personal-notes`** — `POST /`, `GET /muscle/:muscleGroup`, `DELETE /:id`.
- **`macros`** — `POST`/`GET /log`, `DELETE /log/:id`. Goals live in `/api/settings`; summaries are computed client-side.
- **`supplements`** — CRUD plus intake: `POST /:id/log`, `GET /:id/log`, `DELETE /:id/log/:entryId`.
- **`photos/muscle`** — upload (multer memory, image only, 10 MB, magic-byte checked, per-user quota), `GET /`, `GET /group/:muscle`, `GET /:id/image` (raw bytes), `DELETE /:id`. Stored as LONGBLOB with muscle-group tags and a front/back/side/custom angle.

### Settings — `/api/settings`

`GET /` · `PATCH /` — every user preference in one row: hydration goal and error margin, cycle period/length, macro protein/carbs/fat/calorie goals. Ranges are `CHECK` constraints in the schema; a violation comes back as a 400. Never gated by `LOCAL_ONLY_FEATURES` — a box that refuses to store tracking data still remembers the goals.

### Social — `/api/friends` & `/api/sharing`

- **Friends:** `GET /search` (≥2 characters), `GET /`, `GET /requests/{pending,sent}`, `POST /request`, `POST /request/:friendshipId/{accept,reject}`, `DELETE /:friendId`.
- **Blocking:** `POST`/`DELETE /block/:userId` and `GET /blocked`. A block tears down the friendship, every sharing permission in both directions, and any outstanding joint invite, then hides each user from the other's search and blocks new requests.
- **Reporting:** `POST /report` (`userId`, `reason`, optional `details`). There is no central moderator for a self-hosted deployment, so reports are stored on the instance for its operator to review with `pnpm ownlift reports`.
- **Sharing permissions:** `POST /permissions` (grant), `GET /permissions/{granted,received}`, `DELETE /permissions/:permissionId`. Types: `history`, `analytics`, `program`, `joint_session`, `watch_session`, `trainer`.
- **Shared reads:** `GET /sessions/friend/:friendId` and `/sessions/friend/:friendId/:sessionId`.
- **Joint sessions:** `GET /joint-sessions/friend/:friendId/status`, `POST /joint-sessions/invite`, `POST /joint-sessions/invites/:inviteId/{accept,decline}`, `PATCH /joint-sessions/:id/progress`, `DELETE /joint-sessions/:id/leave` — two friends working out in sync.
- **Watch sessions:** `GET /watch/friend/:friendId/active` and `GET /watch/friend/:friendId/session/:sessionId/live` — spectate a friend's live workout.

---

## WebSockets (`/ws`)

Mounted on the same HTTP server. Auth via a JWT `auth` message sent over the socket after connecting — never in the handshake URL, where a long-lived token would be captured by server and proxy access logs. Hardened with a 5 s auth timeout, per-user 20 msg/sec rate limit (exceeding it closes the socket), 8 KB max message size, 30 s heartbeat ping, and zombie-connection replacement.

**Server → client events:** `auth_success`, `error`, `joint_invite`, `invite_status`, `joint_progress`, `joint_session_ended`, `friend_request_received`, `live_set_recorded`, `watch_started`, `watch_stopped`, `trainer_set_recorded`, `trainee_set_recorded`, `session_auto_ended`.
**Client → server:** `auth`, `push_joint_progress`, `leave_joint_session`.

> The WS rate counters are in-process memory — the server is designed for a **single instance**. Horizontal scaling would require a shared store (e.g. Redis).

---

## Background jobs

`startStaleSessionCleanup()` (`jobs/sessionCleanup.ts`) auto-ends workout sessions inactive for >30 min. Runs on boot then every 5 min — a server-side backstop to the client's own inactivity timer. Each ended workout gets a `session_auto_ended` WS event pushed to its owner, so the app doesn't discover it as a 404. The write is a single idempotent `UPDATE`, so overlapping runs are harmless.

---

## Data model

SQL tables (`config/schema.sql`):

- **users** — accounts, profile, admin flag, height/weight-unit prefs, `bf_formula_sex` (used only by the US-Navy body-fat formula) and `token_version` (bumped to invalidate every JWT at once).
- **user_settings** — one row per user holding every preference: hydration goal, cycle lengths, macro goals. Replaced three one-row-per-user settings tables.
- **refresh_tokens** — hashed, opaque, rotating refresh tokens chained by `family_id`, so presenting a spent token revokes the whole family.
- **exercises** — global exercise catalog, unique on name.
- **programs** / **program_days** / **program_exercises** — one program per user, relational rather than a JSON blob. A day keeps its id across re-uploads so workout history keeps its muscle labels.
- **workouts** / **workout_sets** — workout sessions and individual sets (weight, reps, RPE, timing, rest, warm-up).
- **measurements** / **metric_definitions** — every scalar body metric as `(metric, value, measured_at)` rows: weight, body fat, circumferences, hydration, and any metric the user defines. Replaced `body_weight`, `body_fat_measurements`, `body_measurements` and the custom-measurement pair.
- **soreness** / **soreness_follow_up** — a soreness episode and its check-ins. Replaced the parallel `doms_*` tables.
- **menstrual_cycle** · **injuries** · **muscle_notes** · **macros_intake** — one table each, all `user_id`-owned.
- **supplements** / **supplement_intake** — supplement definitions and intake.
- **progress_photos** / **progress_photo_blobs** / **progress_photo_muscles** — metadata, image bytes in their own table, and muscle-group tags.
- **friendships** — one row per pair, stored with `user_id < friend_id` and a `requested_by` column, so a duplicate request is a UNIQUE violation rather than a race.
- **user_blocks** / **user_reports** — blocks in both directions, and reports filed for the instance operator.
- **sharing_permissions** — per-friend access grants, with an optional JSON payload per grant.
- **joint_sessions** / **joint_session_participants** / **joint_session_invites** — synchronized co-workouts.

`schema.sql` is all `CREATE TABLE IF NOT EXISTS` and re-runs on every boot, so a new table needs no migration. Changes to *existing* tables (new columns, indexes) go in `migrations/NNN_description.sql` — each file runs at most once, tracked in a `_migrations` table, applied in filename order on every boot. `migrations/README.md` records each file's minimum supported prior schema.

---

## Configuration

Set these environment variables. A `.env` file is read by Node directly — the `dev`, `start` and `ownlift` scripts pass `--env-file-if-exists=.env`, so there is no `dotenv` dependency:

| Variable          | Required | Default     | Notes                                                              |
| ----------------- | -------- | ----------- | ------------------------------------------------------------------ |
| `PORT`            | no       | `5000`      | HTTP/WS port                                                       |
| `DB_HOST`         | no       | `localhost` | MySQL host                                                         |
| `DB_PORT`         | no       | `3306`      | MySQL port                                                         |
| `DB_USER`         | **yes**  | —           | MySQL user                                                         |
| `DB_PASSWORD`     | **yes**  | —           | MySQL password                                                     |
| `DB_NAME`         | **yes**  | —           | Database name (auto-created if missing)                            |
| `JWT_SECRET`      | **yes**  | —           | Must be ≥ 32 characters                                            |
| `JWT_EXPIRES_IN`  | no       | `15m`       | Access token lifetime (refresh tokens last 30 days)                |
| `ALLOWED_ORIGINS` | **yes**  | —           | Comma-separated CORS origins, matched exactly. `*` is **not** a wildcard here and is refused at boot — list origins explicitly |
| `NODE_ENV`        | no       | —           | `production` masks error details; `development` shows stack traces |
| `SERVER_FQDN`     | no       | —           | Public domain name; advertised over mDNS (`_ownlift._tcp`) and echoed on `GET /healthz`, so clients that find this server on the LAN can connect via this FQDN instead of the raw IP |
| `RATE_LIMIT_BYPASS_LOCAL_IPS` | no | `false` | `true` skips the rate limiters for loopback/private-range client IPs (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) |
| `TRUST_PROXY_HOPS` | no | `0` | Number of trusted reverse-proxy hops in front of the server. Must be a non-negative integer — `TRUST_PROXY_HOPS=true` is refused at boot rather than silently behaving like `0`. **Set this to `1` if you run behind nginx/Caddy/Traefik**, or the rate limiters will key every client into one shared bucket. Leave at `0` when the container's port is exposed directly |
| `PHOTO_QUOTA_MB` | no | `1024` | Per-user progress-photo storage cap, in MB (`0` disables). Photo bytes are the only unbounded growth path on the box, and a full MySQL data directory fails every write on the instance, not just uploads |
| `LOCAL_ONLY_FEATURES` | no | — | Comma-separated features this deployment refuses to store, to save disk: `tracking`, `supplements` (case-insensitive; an unrecognised name is refused at boot). Their routes are not mounted (404) and the list is published on `GET /healthz`, which the app reads to keep those features logging on-device instead |

> ⚠️ **Security:** do not commit real secrets. Rotate any credentials that have been checked into `.env`, and keep `.env` out of version control.

> ⚠️ **`TRUST_PROXY_HOPS`:** this defaults to `0` (don't trust `X-Forwarded-For`) because that is the safe default for a directly-exposed box — otherwise a client can rotate the header to reset the auth rate limiter and brute-force passwords freely. If you terminate TLS at a reverse proxy, you **must** set `TRUST_PROXY_HOPS=1` so `req.ip` is the real client address. Combining `RATE_LIMIT_BYPASS_LOCAL_IPS=true` with `TRUST_PROXY_HOPS=0` behind a proxy makes *every* request look like `127.0.0.1`, which disables both rate limiters for the entire internet; the server prints a loud warning at boot if you configure it that way.

---

## Running

### Development

```bash
pnpm install
pnpm dev          # tsx watch, hot iteration
```

### Tests

```bash
pnpm test                 # vitest run
pnpm test -- --coverage   # with a coverage report
```

The suite needs a live MySQL: `tests/global-setup.ts` drops and rebuilds an `ownlift_test` database from your `.env` credentials, and the route tests drive the real Express app through supertest. There is no linter in this repo.

### Production build

```bash
pnpm build        # tsc + tsc-alias, copies config/schema.sql and migrations/ into dist/
pnpm start        # node dist/server.js
```

### Docker (recommended for self-hosting)

```bash
docker build -t ownlift-server .
docker run -p 5000:5000 --env-file .env \
  --log-opt max-size=10m --log-opt max-file=3 \
  ownlift-server
```

The `--log-opt` flags are not optional in practice: everything this server logs
goes to stdout, and Docker's default `json-file` driver has **no size limit**,
so the log grows without bound on the same disk as your MySQL data.

The image is a two-stage build (`node:24-alpine`, pnpm), runs as a non-root user under `tini`, exposes port 5000 and ships a `HEALTHCHECK` against `/healthz`. Point your MySQL env vars at a reachable database — the DB and schema auto-provision on first boot.

### Releasing

`scripts/release.sh` bumps the version, commits & pushes to `origin main`, then builds and pushes `superak0s/ownlift-server:latest` and `:<version>` to Docker Hub. Run it by hand, only when you mean to publish.

---

## Admin

- The **first registered user** automatically becomes an admin.
- Manage the instance from the CLI (`list` shows every account with an `[admin]`
  marker, since `add`/`remove` need a username spelled exactly):
  ```bash
  pnpm ownlift list                       # every user, admins first
  pnpm ownlift add <username>
  pnpm ownlift remove <username>          # refuses to demote the last admin
  pnpm ownlift passwd <username> [newpw]  # omit the password to be prompted
  pnpm ownlift reports [limit]            # user reports filed on this instance
  ```
  `passwd` is the only account-recovery path — a self-hosted instance may have
  no mail server. It bumps `token_version`, so every device is signed out.
- In Docker, run it against the running container:
  ```bash
  docker exec <container> ownlift list
  ```

---

## Connecting the app

The OwnLift app points at a server URL (default `https://ownlift.superak0s.com`, overridable in the app's Settings), or finds a self-hosted box on the LAN over mDNS. Set the app's server URL to your own instance to keep all data under your control. Auth is JWT-based; workouts, tracking data, and social/live features sync over REST + the `/ws` WebSocket.
