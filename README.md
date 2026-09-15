# OwnLift Server

The optional backend for the [OwnLift](../OwnLift-App) fitness app. It provides cross-device sync, user accounts, and real-time social features (friends, joint workouts, live spectating).

> **The OwnLift app does not require this server** — it runs fully offline out of the box. Run this only if you want to sync across devices or enable social/live features, either via the official instance or your own self-hosted one.

A Node.js / TypeScript REST + WebSocket API, backed by MySQL, Docker-first and self-hostable.

---

## Tech stack

- **Runtime:** Node.js (Docker image `node:24-alpine`), **TypeScript 6.0**, compiled with `tsc`, run via `tsx watch` in dev.
- **Framework:** **Express 5**.
- **Database:** **MySQL** via `mysql2` (`mysql2/promise` connection pool). No ORM — hand-written SQL with a versioned `schema.sql`.
- **Auth:** **JWT** (`jsonwebtoken`, HS256) + **bcryptjs** (12 salt rounds) for password hashing.
- **Real-time:** **WebSockets** (`ws`).
- **Uploads:** **multer** (memory storage for photos; magic-byte checked, stored as LONGBLOB).
- **Security:** `helmet`, `cors`, `express-rate-limit`.
- **Compression:** `compression` — gzip on JSON responses over 1 kb (already-compressed types like photo BLOBs are skipped).
- **Package manager:** **pnpm**.

---

## Architecture

Request pipeline (`server.ts`): `helmet` → `cors` (locked to `ALLOWED_ORIGINS`) → `compression` (gzip, 1 kb threshold) → per-request UUID + logger → rate limiters → `express.json` (50 kb limit) → `GET /healthz` → routes → static `public/` → 404 → global error handler. Body parsing sits *after* the rate limiters so a flood is rejected before the server pays to buffer and parse the payload.

- **Fails fast** on boot if `JWT_SECRET` is missing/`<32` chars or `ALLOWED_ORIGINS` is unset.
- **Rate limits:** `/api/auth` = 20 req / 15 min; `/api` = 200 req / 60 s.
- On startup: tests the DB connection, auto-provisions the database + schema on a fresh install, starts the stale-session cleanup job, and listens on `PORT` (default 5000). Graceful shutdown on SIGTERM/SIGINT.

---

## API

All routes are under `/api` and require a JWT `Authorization: Bearer <token>` unless noted.

### Auth — `/api/auth`

| Method | Path            | Purpose                                                         |
| ------ | --------------- | --------------------------------------------------------------- |
| POST   | `/signup`       | Register (first-ever user auto-becomes admin); returns JWT      |
| POST   | `/signin`       | Login by username or email; returns JWT                         |
| GET    | `/me`           | Current user                                                    |
| PUT    | `/profile`      | Update name/email                                               |
| PUT    | `/password`     | Change password                                                 |
| DELETE | `/account/data` | Wipe all user data (confirm `DELETE_ALL_DATA`); keeps account   |
| DELETE | `/account`      | Delete the account and everything it owns (re-checks password)  |
| GET    | `/account/export` | Everything held about the caller as JSON (photo bytes omitted) |
| POST   | `/refresh`      | Reissue a JWT (must still be valid)                             |
| POST   | `/logout-all`   | Invalidate every JWT issued to this account (this one included) |

### Sessions (workouts) — `/api/sessions`

`GET /` (history) · `POST /start` · `POST /:id/set` (record set, pushes live WS update) · `PATCH /:id/sets/:setId` (edit set) · `POST /:id/end` · `GET /:id` · `POST /rename-exercise` · plus admin/bulk delete routes.

### Program — `/api/program`

`GET /` · `POST /upload` (persist client-parsed program JSON, 2 MB cap) · `DELETE /` · `PATCH /exercise/{rename,add,sets}`. Program spreadsheets are parsed **client-side**; the server only validates and stores.

### Analytics / Version

`GET /api/analytics` (comprehensive workout analytics) · `GET /api/version`. An unauthenticated `GET /healthz` liveness probe is served outside `/api`.

### Tracking — `/api/tracking/*`

- **`bodystats`** — weight log & stats, height/unit prefs, body-fat logging + US-Navy calculation.
- **`macros`** — intake logging, daily/weekly/monthly summaries, goals.
- **`supplements`** — CRUD, intake logging + streaks.
- **`photos`** — general body photos: upload (multer memory, image only, 10 MB, magic-byte checked), list, fetch raw bytes, delete. `photos/muscle` is the muscle-tagged variant: upload (multer memory, image only, 10 MB, magic-byte checked), list, list by muscle, fetch raw bytes, delete. Stored as LONGBLOB with muscle-group tags.

### Social — `/api/friends` & `/api/sharing`

- **Friends:** search, list, pending/sent requests, request/accept/reject/remove, privacy-preserving contact matching (SHA-256 hashed emails).
- **Blocking:** `POST`/`DELETE /api/friends/block/:userId` and `GET /api/friends/blocked`. A block tears down the friendship, every sharing permission in both directions, and any outstanding joint invite, then hides each user from the other's search and blocks new requests.
- **Reporting:** `POST /api/friends/report` (`userId`, `reason`, optional `details`). There is no central moderator for a self-hosted deployment, so reports are stored on the instance for its operator to review with `pnpm ownlift reports`.
- **Sharing permissions:** grant/revoke access by type — `history`, `analytics`, `program`, `joint_session`, `watch_session`.
- **Joint sessions:** invite, accept/decline, live progress push, leave — two friends working out in sync.
- **Watch sessions:** spectate a friend's active live session.

---

## WebSockets (`/ws`)

Mounted on the same HTTP server. Auth via a JWT `auth` message sent over the socket after connecting — never in the handshake URL, where a long-lived token would be captured by server and proxy access logs. Hardened with a 5 s auth timeout, per-user 20 msg/sec rate limit, 8 KB max message size, 30 s heartbeat ping, and zombie-connection replacement.

**Server → client events:** `joint_invite`, `invite_status`, `friend_request_received`, `live_session_update`, `joint_progress`, `joint_session_ended`, `auth_success`, `error`, and session-status events.
**Client → server:** `push_joint_progress`, `leave_joint_session`.

> The WS rate counters are in-process memory — the server is designed for a **single instance**. Horizontal scaling would require a shared store (e.g. Redis).

---

## Background jobs

`startStaleSessionCleanup()` (`jobs/sessionCleanup.ts`) auto-ends workout sessions inactive for >30 min. Runs on boot then every 5 min (reentrancy-guarded) — a server-side backstop to the client's own inactivity timer.

---

## Data model

SQL tables (`config/schema.sql`):

- **users** — accounts, profile, admin flag, height/weight-unit prefs.
- **exercises** — global exercise catalog.
- **sessions** / **set_timings** — workout sessions and individual sets (weight, reps, timing, rest, warm-up).
- **workout_programs** — one program per user (JSON).
- **body_weight** / **body_fat_measurements** — body tracking.
- **supplements** / **supplement_log** — supplement definitions and intake.
- **progress_photos_muscle** (+ **_tags**) — image BLOBs, metadata and muscle-group tags.
- **macros_goals** / **macros_intake** — nutrition.
- **friendships** — friend relationships & status.
- **sharing_permissions** — per-friend access grants.
- **joint_sessions** / **joint_session_participants** / **joint_session_invites** — synchronized co-workouts.

`schema.sql` covers the initial `CREATE TABLE IF NOT EXISTS` shape of every table. Changes to existing tables (new columns, indexes) go in `migrations/*.sql` — each file runs at most once, tracked in a `_migrations` table, applied in filename order on every boot.

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
| `JWT_EXPIRES_IN`  | no       | `7d`        | Token lifetime                                                     |
| `ALLOWED_ORIGINS` | **yes**  | —           | Comma-separated CORS origins                                       |
| `NODE_ENV`        | no       | —           | `production` masks error details; `development` shows stack traces |
| `SERVER_FQDN`     | no       | —           | Public domain name; advertised over mDNS (`_ownlift._tcp`) so clients that find this server on the LAN can connect via this FQDN instead of the raw IP |
| `RATE_LIMIT_BYPASS_LOCAL_IPS` | no | `false` | `true` skips the rate limiters for loopback/private-range client IPs (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) |
| `TRUST_PROXY_HOPS` | no | `0` | Number of trusted reverse-proxy hops in front of the server. **Set this to `1` if you run behind nginx/Caddy/Traefik**, or the rate limiters will key every client into one shared bucket. Leave at `0` when the container's port is exposed directly |

> ⚠️ **Security:** do not commit real secrets. Rotate any credentials that have been checked into `.env`, and keep `.env` out of version control.

> ⚠️ **`TRUST_PROXY_HOPS`:** this defaults to `0` (don't trust `X-Forwarded-For`) because that is the safe default for a directly-exposed box — otherwise a client can rotate the header to reset the auth rate limiter and brute-force passwords freely. If you terminate TLS at a reverse proxy, you **must** set `TRUST_PROXY_HOPS=1` so `req.ip` is the real client address.

---

## Running

### Development

```bash
pnpm install
pnpm dev          # tsx watch, hot iteration
```

### Production build

```bash
pnpm build        # tsc + copies config/schema.sql into dist/
pnpm start        # node dist/server.js
```

### Docker (recommended for self-hosting)

```bash
docker build -t ownlift-server .
docker run -p 5000:5000 --env-file .env ownlift-server
```

The image is a two-stage build (`node:24-alpine`, pnpm), runs `node dist/server.js`, and exposes port 5000. Point your MySQL env vars at a reachable database — the DB and schema auto-provision on first boot.

### Releasing

`release.sh` bumps the version, commit & push to `origin main`, then build and push `superak0s/ownlift-server:latest` and `:<version>` to Docker Hub.

---

## Admin

- The **first registered user** automatically becomes an admin.
- Manage admins via the CLI:
  ```bash
  pnpm ownlift list
  pnpm ownlift add <username>
  pnpm ownlift remove <username>
  ```
- In Docker, run it against the running container:
  ```bash
  docker exec <container> ownlift list
  ```

---

## Connecting the app

The OwnLift app points at a server URL (default `https://ownlift.superak0s.com`, overridable in the app's Settings). Set the app's server URL to your self-hosted instance to keep all data under your control. Auth is JWT-based; workouts, tracking data, and social/live features sync over REST + the `/ws` WebSocket.
