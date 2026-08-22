# Technical reference

## What the worker serves

- `/` - the macros chart. Stacked daily bars for the eight tracked macros
  (calories, protein, carbs, fat, saturated fat, sugar, fiber, sodium), each
  with a goal line. Clicking a bar expands it into the items logged that day.
  Data comes from two Notion databases: a daily rollup and a per-item Log.
  Daily goals are editable in-page at `/goals`; saved values win over the
  code defaults.
- Workout charts, same page, from three Notion databases (Push / Pull /
  Legs). Cells are free text like `165x6, 175x6 (good reps)`; a
  deterministic parser pulls weight x rep pairs, drops anything in
  parentheses, and takes the session's top set (a 2-rep-or-fewer top set
  falls back to the next heaviest; pull-up columns take the minimum because
  the number there is assist weight). A cell that doesn't parse becomes a
  gap, never a zero. Parse results are written back into per-exercise `(wt)`
  number columns; the free-text cell stays authoritative.
- JSON feeds the pages poll: `/data.json`, `/workout.json`, plus `/v` (a
  version string an open page polls to refresh itself) and `/status`.
- `POST /notion-webhook` - Notion fires this on database edits; the worker
  verifies it, 200s, and refreshes its KV cache in the background.

## Access model

The chart is password-gated: a correct password sets a signed device cookie
good for a year (`/logout` clears it). Notion embed frames carry a separate,
rotatable capability token (`?k=`) because the Notion iOS webview blocks
third-party storage. Rotate it by overwriting the `embed_token_v1` KV key
and bumping `ver_v1`; rotate the gate password with
`wrangler secret put GATE_PASSWORD` (or the Cloudflare API) and every device
re-enters it once. Keep the actual password in your password manager
(Bitwarden, 1Password, ...).

## Repo layout

```
worker/worker.js            the worker: the macros + workout chart page
worker/wrangler.toml.example  every binding and env var, with paste-me placeholders
ci/deploy.sh                settings fetch-merge + multipart PUT (no build step)
ci/smoke.sh                 live feature-preservation smoke; needs SMOKE_BASE + SMOKE_K
.github/workflows/deploy.yml  Test on every push; Deploy + Smoke on manual dispatch
tests/feature-guard.mjs     static+render checks that key features can't be deleted silently
tests/PORT_NOTES.md         archaeology notes from a mid-history minification event
FORMATTING.md               THE contract for agents writing rows to the Log database
```

## CI pipeline

Every push runs Test (`node --check worker/worker.js`,
`tests/feature-guard.mjs`). Deploy runs on manual workflow dispatch:
`ci/deploy.sh` pulls current worker settings first so bindings survive,
then multipart PUTs the script as `application/javascript+module`. Smoke
(`ci/smoke.sh`) follows: it polls the live page for marker strings that
pin user-facing features - window toggles, the Average view, workout
blow-up rows/hatching - and fails red on a silent rollback. GitHub Action
secrets are snapshotted at run creation, so rotate a secret before
deploying, not mid-run. The owner's production instance deploys from the
`feature/apple-health` branch, which carries the Apple Health stack.
