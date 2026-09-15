# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The optional backend for the OwnLift fitness app (sibling repo `../OwnLift-App`, which runs fully offline without this server). Every user self-hosts their own instance — there is no central OwnLift server, so an instance is one person plus whoever they invite, never a multi-tenant service. Design for a single small box: no horizontal scaling, no shared cache/queue, and no assumption that other instances exist or can reach each other. A Node.js/TypeScript REST + WebSocket API backed by MySQL, providing cross-device sync, accounts, and real-time social features (friends, joint workouts, live spectating). No ORM — hand-written SQL via `mysql2/promise`.

## Commands

```bash
pnpm install
pnpm dev              # tsx watch server.ts — hot reload dev server
pnpm build             # tsc + copies config/schema.sql and migrations/ into dist/
pnpm start             # node dist/server.js (run after build)
pnpm ownlift list|add|remove <username>   # tsx ownlift.ts — manage admin users (docker: `docker exec <container> ownlift ...`)
pnpm ownlift passwd <username> <newpw>   # reset a password — the only recovery path, since a self-hosted instance may have no mail server
pnpm ownlift reports [limit]             # list user reports filed on this instance
```

`pnpm test` runs the vitest suite (`vitest run`; add `--coverage` when you want a report). It needs a live MySQL — `tests/global-setup.ts` drops and rebuilds an `ownlift_test` database from `.env` credentials, and route tests drive the real `app` through supertest. There is no linter — don't invent `pnpm lint`.

Requires a `.env`, loaded by Node itself via `--env-file-if-exists=.env` in the `dev`/`start`/`ownlift` scripts — there is no `dotenv` dependency, so any *new* entry point must pass that flag too. See README.md for the full variable table. At minimum `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET` (≥32 chars), and `ALLOWED_ORIGINS` must be set or the server throws on boot (`server.ts`). The DB and schema auto-provision on first connect against a fresh database.

## Architecture

**Request pipeline** (`server.ts`): `helmet` (CSP locked to `default-src 'none'` — pure JSON API, no HTML views) → `cors` (locked to `ALLOWED_ORIGINS`) → `compression` (gzip; defaults — 1kb threshold, and the built-in filter skips already-compressed types so photo BLOBs aren't re-zipped) → per-request UUID (`req.reqId`) + logger → rate limiters (`/api/auth`: 20/15min, `/api`: 200/60s) → `express.json` (50kb limit; `/api/program/upload` gets its own 2mb-limit parser mounted first, behind `authenticateToken`) → unauthenticated `GET /healthz` liveness check (for Docker/load balancer) → routes → static `public/` → 404 → global `errorHandler`. Body parsing deliberately sits *after* the rate limiters and, for the 2mb parser, behind auth — parsing before the cheap rejects let an anonymous caller buy seconds of `JSON.parse` CPU per minute on a single-core box. `trust proxy` is driven by `TRUST_PROXY_HOPS` (default `0`): behind a TLS-terminating reverse proxy it must be `1` or rate-limit keys collapse onto one bucket, but it must stay `0` when the port is exposed directly or a client can spoof `X-Forwarded-For` to reset its own limiter. The HTTP server and the WebSocket server (`ws/wsServer.ts`) share the same `http.createServer` instance. On listen, the server also advertises itself over mDNS as `_ownlift._tcp` (`bonjour-service`) with `SERVER_FQDN` in the TXT record, so LAN clients can discover a self-hosted box without knowing its IP; `getLanInterface()` hand-picks a physical NIC because multicast-dns otherwise binds to a Docker/WSL/VPN adapter. `SIGTERM`/`SIGINT`/unhandled rejections all route through `shutdown()` — tear down any new long-lived resource there.

**Feature-first layout**: code lives under `features/<domain>/`, not in top-level `routes/`/`models/` directories. Each feature is a flat trio of same-named files: `<name>.routes.ts` (Express router, request validation), `<name>.model.ts` (SQL via `pool.execute<RowDataPacket[]>` / `pool.execute<ResultSetHeader>` from `config/database.ts`), and often `<name>.types.ts`. Bigger domains nest sub-features one level deeper — `features/tracking/<metric>/<metric>.{routes,model}.ts` (`bodyStats`, `measurements`, `hydration`, `soreness`, `macros`, `supplements`, `menstrual`, `injury`, `personalNotes`, `progressPhoto` — `bodyStats` and `hydration` are thin routers over `measurements`, which owns every scalar metric) and `features/social/<subfeature>/` (`friends`, `sharing`). Workout sessions live in `features/workouts/` (mounted at `/api/sessions`, not `/api/workouts`). `routes.ts` at the repo root is where every router gets mounted via `registerRoutes(app)` — add new route modules there, following the existing `app.use("/api/...", ...)` list. One thing to respect: `/api/version` is an inline `app.get` rather than a router, so route-scanning tools miss it. `registerRoutes` also gates whole feature groups on `LOCAL_ONLY_FEATURES` (comma-separated, `tracking` and/or `supplements`): listed features are never mounted, so this box stores none of their data, and the list is echoed on `GET /healthz` for the app to read — it then keeps those features logging on-device via its own `on`/`off` service split, so dropping a feature from the server is a config change, not a client release.

**Auth**: JWT (HS256, `jsonwebtoken`) verified in `middleware/auth.ts`. `authenticateToken` requires a valid token and attaches `req.user`. Passwords hashed with bcryptjs (12 rounds). The first-ever registered user auto-becomes admin (`features/auth/`; `ownlift.ts` CLI manages further admins).

**Validation**: `middleware/validation.ts` exports the shared primitives every route reuses — `parseIntParam` (rejects ids < 1), `queryLimit` (default + clamp for `?limit=`), `validateRequired`, plus per-domain body validators. They throw `ValidationError` synchronously; Express 5 forwards thrown errors, so no `try`/`catch` + `next(err)` wrapper is needed. Don't hand-roll id parsing or limit clamping in a new route.

**Errors**: `middleware/errorHandler.ts` defines typed error classes (e.g. `UnauthorizedError`) and the global handler; routes/middleware should throw/`next()` these rather than crafting raw error responses. `NODE_ENV=production` masks internal error details.

**WebSockets** (`ws/wsServer.ts`, mounted at `/ws`): auth via a JWT `auth` message sent over the socket — never in the handshake URL, where a long-lived token would land in access logs. 5s auth timeout, per-user 20 msg/sec limit, 8KB max message size, 30s heartbeat, zombie-connection replacement. Rate counters are in-process memory — **the server is single-instance only**; horizontal scaling needs a shared store.

**Background jobs**: `jobs/sessionCleanup.ts` auto-ends workout sessions idle >30min; runs on boot then every 5min, reentrancy-guarded.

**Database**: schema lives in `config/schema.sql`, entirely `CREATE TABLE IF NOT EXISTS` statements, re-run idempotently on every boot. New tables go straight into `schema.sql` as another `CREATE TABLE IF NOT EXISTS` block — it re-runs on every boot, so an existing deployment picks them up without a migration. Changes to *existing* tables (new columns, indexes) go in a new `migrations/NNN_description.sql` file instead — `runMigrations()` (`config/database.ts`) applies each one at most once, tracked in a `_migrations` table, in filename order on every boot. `pnpm build` copies `migrations/` into `dist/` alongside `schema.sql`. `migrations/` is currently empty (see `migrations/README.md`): the old files targeted the pre-rename `sessions`/`set_timings` tables and would break or damage current deployments, so live databases from before the rename to `workouts` cannot be upgraded and must be re-created.

**Uploads**: `multer` memory storage for photos only (stored as `LONGBLOB` in MySQL, 10MB cap, image-only, magic-byte checked). Workout program spreadsheets are parsed client-side in the app; the server only validates the resulting JSON (2MB cap) and unpacks it into `programs`/`program_days`/`program_exercises`, rebuilding the same JSON shape on read.

**Module system**: ESM (`"type": "module"` in package.json). Local imports must use explicit `.js` extensions even though source is `.ts` (NodeNext resolution) — e.g. `import { findUserByEmail } from "../auth/user.model.js"`.

**Path aliases**: `@/*` maps to the repo root (`paths` in `tsconfig.json`; no `baseUrl`, which is deprecated in TypeScript 6). Anything that would climb two or more levels uses the alias — `import { pool } from "@/config/database.js"` — while a single `../` to a sibling stays relative. The `.js` extension is still required on aliased specifiers. `tsx` resolves `paths` natively in dev, but `tsc` does *not* rewrite them on emit, so `pnpm build` runs `tsc && tsc-alias` — `tsc-alias` turns every `@/` back into a relative path inside `dist/`. Any new build or entry point must keep that second step, or the emitted JS will import a specifier Node cannot resolve.

## Releasing

`scripts/release.sh` (Git Bash on Windows) bumps the version, commits & pushes to `origin main`, then builds and pushes `superak0s/ownlift-server:latest` and `:<version>` to Docker Hub. This is a real deploy action — don't run it without being asked to release.
