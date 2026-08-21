# apple-health-dashboard

A personal health + nutrition dashboard behind one Cloudflare Worker: stacked
macro charts fed by Notion, workout charts fed by Notion, and an Apple Health
page fed by an iOS Shortcut that POSTs into Cloudflare D1. One worker, no
build step, no other frontend.

Use this repo as a guide + working scripts for building your own copy: fork
it, create the Notion databases, set the env vars and secrets below, and
deploy. It also works as a foundation for an agent-driven setup: an agent can
create the Notion databases and wire the bindings for you, and if it logs
food into your Log database it must follow [FORMATTING.md](FORMATTING.md).

## What the worker serves

- `/` - the macros chart. Stacked daily bars for the eight tracked macros
  (calories, protein, carbs, fat, saturated fat, sugar, fiber, sodium), each
  with a goal line. Clicking a bar expands it into the items logged that day.
  Data comes from two Notion databases: a daily rollup and a per-item Log.
  Daily goals are editable in-page at `/goals`; saved values win over the code
  defaults.
- Workout charts, same page, from three Notion databases (Push / Pull / Legs).
  Cells are free text like `165x6, 175x6 (good reps)`; a deterministic parser
  pulls weight x rep pairs, drops anything in parentheses, and takes the
  session's top set (a 2-rep-or-fewer top set falls back to the next
  heaviest; pull-up columns take the minimum because the number there is
  assist weight). A cell that doesn't parse becomes a gap, never a zero.
  Parse results are written back into per-exercise `(wt)` number columns;
  the free-text cell stays authoritative.
- `/health` - the Apple Health dashboard: body composition, activity, heart,
  sleep by stage, workouts, and the long tail of everything else, imperial
  units over a rolling window. Data lives in D1 in canonical SI units and is
  converted at render.
- JSON feeds the pages poll: `/data.json`, `/workout.json`,
  `/health/data.json`, `/health/samples.json`, plus `/v` (a version string an
  open page polls to refresh itself) and `/status` / `/health/status`.
- `POST /notion-webhook` - Notion fires this on database edits; the worker
  verifies it, 200s, and refreshes its KV cache in the background.
- `POST /health/ingest` and `POST /health/seed` - the Apple Health write
  endpoints, authenticated by an `X-Health-Key` header.

## Access model

The chart is password-gated: a correct password sets a signed device cookie
good for a year (`/logout` clears it). Notion embed frames carry a separate,
rotatable capability token (`?k=`) because the Notion iOS webview blocks
third-party storage. Rotate it by overwriting the `embed_token_v1` KV key and
bumping `ver_v1`; rotate the gate password with `wrangler secret put
GATE_PASSWORD` (or the Cloudflare API) and every device re-enters it once.
Keep the actual password in your password manager (Bitwarden, 1Password, ...).

## Repo layout

```
worker/worker.js            the worker: charts, health pages, ingest endpoints
worker/schema.sql           the D1 schema (also auto-created on first request)
worker/wrangler.toml.example  every binding and env var, with paste-me placeholders
ci/deploy.sh                settings fetch-merge + multipart PUT (no build step)
ci/smoke.sh                 live feature-preservation smoke; needs SMOKE_BASE + SMOKE_K
.github/workflows/deploy.yml  push-to-main pipeline: Test -> Deploy -> Smoke
shortcut/generate_health.py   generates the iOS Shortcuts that POST Apple Health to /health/ingest
shortcut/shortcut_lib.py      plist action builders shared by the generator
parser/hkparse.py           streams the Health app's export.zip into daily-aggregate seed JSON for /health/seed
parser/test_hkparse.py        parser unit tests
tests/feature-guard.mjs     static+render checks that key features can't be deleted silently
tests/PORT_NOTES.md           archaeology notes from a mid-history minification event
docs/first-run-readout.md     how to read the first real Shortcut run
FORMATTING.md               THE contract for agents writing rows to the Log database
```

## Setting up your own copy

1. **Notion.** Create four databases and share them with a Notion integration:
   a rollup (one row per day, numeric columns per macro), a Log (one row per
   item; the column contract is in [FORMATTING.md](FORMATTING.md)), and three
   workout databases. Wire `POST /notion-webhook` as the webhook target.
2. **Cloudflare.** Create one D1 database and one KV namespace; fill
   `worker/wrangler.toml.example` -> `wrangler.toml` (git-ignored).
3. **Env vars (plain text, on the worker):** `DATABASE_ID` (rollup),
   `NOTION_LOG_DB` (Log), `WORKOUT_DB_PUSH` / `WORKOUT_DB_PULL` /
   `WORKOUT_DB_LEGS`, `DAY_PAGES_JSON` (date -> Notion page URL map, used for
   day-popup deep links).
4. **Secrets:** `NOTION_TOKEN`, `GATE_PASSWORD`, `HEALTH_INGEST_KEY`,
   `EMBED_TOKEN` (legacy - the live embed capability rotates via the
   `embed_token_v1` KV key described above).
5. **CI secrets/vars:** `CF_API_TOKEN` + `CF_ACCOUNT_ID` (secrets) for the
   Deploy job; `SMOKE_K` (secret) + `SMOKE_BASE` (variable) for Smoke.
6. **Deploy.** Push to `main`; Actions runs Test (`node --check` + parser
   unit tests + the feature guard), Deploy (`ci/deploy.sh`), then Smoke
   (`ci/smoke.sh` fails red if user-facing features vanish from the served
   HTML, so a silent feature rollback cannot ship).
7. **iOS Shortcut.** `HEALTH_INGEST_ENDPOINT=... python3 shortcut/generate_health.py
   /tmp/out` writes the shortcut files; the ingest key is read at run time
   from a text file in iCloud Drive, never baked into the shortcut.

Cloudflare's free tier is nowhere near a constraint for one person's data.
