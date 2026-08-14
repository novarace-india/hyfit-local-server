# hyfit-local-server

The HYFIT frontend and backend copied out of `Novarace/` into a standalone app
that runs on its own, against a local Postgres you configure — no Novarace
portal, no results site, no TypeORM, no AWS Secrets Manager.

Copied from `Novarace/` on 2026-08-13.

## What's here

```
backend/    NestJS — the hyfitgames + hyfit-judge modules only
frontend/   Next.js — the (hyfitgames) route group only (22 routes)
```

The two backend modules were copied verbatim; nothing inside them was edited.
Only the four files the host app owned were rewritten, and each drops something
this app has no use for:

| File            | What changed                                                     |
|-----------------|------------------------------------------------------------------|
| `app.module.ts` | Mounts the two HYFIT modules; no TypeORM, no global auth guards   |
| `main.ts`       | Reads `.env` directly; no AWS Secrets Manager fetch               |
| `server.ts`     | Same bootstrap as Novarace, same `api` prefix and interceptors    |
| `common/cache/` | `CacheService` trimmed to get/set/delete/deletePattern; no TypeORM |

Four apps ship inside those routes, and they authenticate separately:

| App        | Frontend route         | API prefix           | Sign-in                         |
|------------|------------------------|----------------------|---------------------------------|
| Athlete    | `/hyfitgames`          | `/api/hyfitgames`    | mobile + OTP → bearer token     |
| Admin      | `/hyfitgames/admin`    | both prefixes        | email + password (dual session) |
| Judge      | `/hyfitgames/judge`    | `/api/hyfit-judge`   | staff ID + PIN → cookie         |
| Check-in   | `/hyfitgames/checkin`  | `/api/hyfit-judge`   | staff ID + PIN → own cookie     |

The check-in counter no longer has a stage assigned to it — see
[Check-in: the athlete decides the stage](#check-in-the-athlete-decides-the-stage).

## Running it

### 1. Database

Two schemas, in one database. They are separate on purpose and neither has a
foreign key into the other, but the running app needs both: the hyfitgames pool
pins `search_path=hyfit,public`, and the judge/check-in pool uses `hyfit_v2`.

```bash
createdb hyfit_local

# The athlete platform's schema — flattened end state of migrations 043–079.
psql -d hyfit_local -v ON_ERROR_STOP=1 -f backend/sql/hyfit_schema.sql

# The field-operations schema — flattened end state of 080 + 082.
psql -d hyfit_local -v ON_ERROR_STOP=1 -f backend/sql/hyfit_v2_schema.sql

# A super_admin to sign in as. Dev credentials only.
psql -d hyfit_local -v ON_ERROR_STOP=1 -f backend/sql/seed_hyfit_admin.sql
psql -d hyfit_local -v ON_ERROR_STOP=1 -f backend/sql/seed_hyfit_v2_admin.sql
```

That seeds `admin@hyfitgames.com` / `admin123` in both schemas — a throwaway
password for a dev database, and the reason these seeds must never be pointed at
production.

`hyfit_v2_schema.sql` creates all six tables of the field schema — `events`,
`raceresults_endpoints`, `users`, `sessions`, `refresh_tokens`, `audit_events` —
with their indexes, constraints and comments. It is idempotent and safe to
re-run. The numbered files beside it (`080`, `081`, `082`) are the historical
chain; use those only to move an *existing* database forward. In particular
`082` is a catch-up migration for a schema built by the first version of `080`,
and has nothing to add to one created from `hyfit_v2_schema.sql`.

`sql/check_hyfit_v2.sql` is the fuller verification pass once it is up.

### 2. Backend (port 3001)

```bash
cd backend
cp .env.example .env      # already points at localhost:5432/hyfit_local
npm install
npm run start:dev
```

`.env.example` lists every variable the copied source actually reads, and
nothing else. Two are worth knowing about:

- `DB_PASSWORD` is the only one with no fallback — the pool throws on startup
  if it is unset. An empty value is fine for a trust-auth local Postgres.
- `VALKEY_ENABLED=false` (the default here) makes every cache call a no-op and
  sends reads straight to Postgres, so no Redis/Valkey is needed locally.

### 3. Frontend (port 3000)

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Then open <http://localhost:3000> — `/` redirects to `/hyfitgames/`.

The routes keep their `/hyfitgames` prefix even though HYFIT is the whole app
here, so every internal link, cookie path and API path stays byte-identical to
production. Browser `/api/*` calls are rewritten through this Next server to the
backend, which is what keeps every request same-origin so the backend's session
cookies actually stick — without it, login appears to succeed and the session
silently never sets.

`npm run dev:lan` binds 0.0.0.0 if you need to reach it from a tablet.

## Check-in: the athlete decides the stage

There are no Stage 1 desks and Stage 2 desks. One counter runs whichever
hand-over the athlete in front of it is due, worked out from the equipment they
are already holding:

| Already holds           | Counter runs                        |
|-------------------------|-------------------------------------|
| nothing                 | Stage 1 — hand over a wristband      |
| a wristband             | Stage 2 — hand over a transponder    |
| both                    | nothing; it says so and names both   |

That answer comes from the **equipment mapping endpoint** (`map_lookup_url`,
set in Operations), which is now the counter's authority on equipment and is
required — an event without it cannot check anyone in, where it used to only
lose the wristband lookup. Two questions are asked of it, both re-read fresh at
the moment of a hand-over rather than from the 20-second cache:

- **what this BIB holds**, which decides the stage, and
- **who holds the scanned code**, which is a check the counter did not have
  before. A wristband or transponder already against a different BIB is refused
  and the holder is named. A code on two athletes corrupts the timing data for
  both and does it silently — each row looks perfectly valid on its own.

The participant feed supplies identity — name, contest, slot, club — and decides
nothing. In particular `Transponder1` **on the feed** is pre-populated by the
organiser for the whole field before the event opens, and a value somebody typed
into a spreadsheet is not a hand-over, so equipment is read from the mapping
table or not at all. The feed's stage flags are consulted for exactly one thing:
confirming, after a write, that RaceResult really stored what it said it stored.

`GET /checkin/participant` reflects that. It answers with `assignment` (what the
athlete holds) and `nextStage` (what is left to give them) and carries no
`stages` field — that used to be the feed's `stage1checkin`/`stage2checkin`
flags, which meant two fields in one payload answering "has this athlete been
through?", able to disagree, with nothing in the shape of the response to say
which one counted.

Its lookup parameter matches **either** column of the mapping table:

```
GET /api/hyfit-judge/checkin/participant?wristband=Z-99999   # a transponder resolves too
GET /api/hyfit-judge/checkin/participant?code=Z-99999        # same thing, honest name
GET /api/hyfit-judge/checkin/participant?bib=11651
```

Someone at the counter is carrying a wristband, or a transponder, or both, and
which one they hold up is not the desk's decision — a lookup that only ever
meant "wristband" simply failed to find an athlete who offered the other. The
wristband wins a code somehow present in both columns, matching the judge app.
`wristband` stays supported as the parameter name so no client has to change.

> **The one assumption to check before an event.** All of this rests on the
> mapping table recording assignments *as they happen*. If its transponder
> column arrives pre-populated the way the participant feed's does, every
> athlete will read as already holding one: the first counter will hand over a
> wristband and the next scan will answer "already holds wristband A-… and
> transponder …", naming a transponder nobody issued. That message is the
> symptom. Point the endpoint at a table that starts empty.

Nothing about a stage is stored in Postgres any more. `hyfit_v2.users.checkin_stage`
is left in place and left NULL — no migration to run — and nothing reads or
writes it; the Team screen no longer offers it, and a `checkinStage` column in a
CSV staff import is read past rather than rejected.

## Venue tools

Two screens at `/hyfitgames/tools/`, outside all four apps and outside their
sessions. Linked from the admin sidebar, but not behind its login — the
download page has to open on a phone that has no app and no account yet.

### `/hyfitgames/tools/apps` — install the field apps

Serves the judge and check-in installers with a QR each. Drop an `.apk` into
`frontend/public/apps/judge/` or `frontend/public/apps/checkin/` and reload;
newest mtime wins, older files in the folder stay listed underneath. There is
nothing to rename and no page to edit, and `public/apps/*/*.apk` is gitignored
so builds stay out of the repo. See `frontend/public/apps/README.md`.

The QR encodes an absolute URL, and it has to be one the *phone* can reach, so
the host is chosen in the browser: from the address bar when that is already a
real address, and from the machine's LAN interfaces when it is loopback. A
picker switches between them for a machine on both Wi-Fi and Ethernet. Serve
with `npm run dev:lan` so the LAN can reach it at all.

### `/hyfitgames/tools/qr` — text/JSON to QR

Paste text or JSON, get a symbol on the page. Validates JSON and re-serialises
it compactly before encoding, because pretty-printed JSON spends a third of a
symbol's capacity on whitespace; error-correction level is selectable and the
byte counter is against that level's ceiling. Over the ceiling the page says so
instead of rendering — `qrcode.react` throws mid-render on an oversized payload,
which in a client component takes the whole page down.

Everything is drawn in the browser. No payload reaches the backend.

## Verified

- `backend`: `npm run build` clean, `npm test` 296 passing.
- `frontend`: `npm run build` clean, 24 routes.
- The check-in counter was walked end-to-end in a headless browser against the
  **real** service classes — only Postgres and the RaceResult server were faked
  — covering all 18 of: a counter opening with no stage, Stage 1 derived for an
  athlete holding nothing, a band already on another BIB refused by name, the
  hand-over, the same athlete coming back as Stage 2, being found by the band
  just issued, the transponder, and finally reading as fully checked in. The
  feed's pre-populated `Transponder1` was confirmed not to leak into the
  decision. A second walk issued a transponder and then found that athlete by
  the transponder alone, and the lookup response was checked to carry no
  `stages` key.
- Both tools were driven in headless Chrome and the QR codes read back out of
  the canvases they rendered: the generator round-tripped a JSON payload
  byte-for-byte, and the download page — opened on `localhost` — auto-selected
  the LAN address and encoded `http://<lan>:<port>/apps/<app>/<file>.apk` for
  both apps. An `.apk` under `public/` is served whole and as
  `application/vnd.android.package-archive`; `trailingSlash` does not redirect
  it. Over-capacity input and malformed JSON were checked too: the first shows
  the ceiling instead of rendering, the second flags the parse error and
  encodes the raw text.
- Three pre-existing type errors live in `hyfit-judge/*.spec.ts`. They are
  present in Novarace too, and `tsconfig.build.json` excludes spec files, so
  they do not affect the build.
- `hyfit_v2_schema.sql` was diffed statement-by-statement against `080` — the
  DDL is identical, and every column and constraint `082` adds is present. It
  has **not** been executed against a live Postgres; there is no `psql` on this
  machine.
