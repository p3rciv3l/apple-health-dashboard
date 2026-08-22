# Setting up your own copy

Accounts you need first: a Notion workspace you control and a Cloudflare
account. (The Apple Health add-on, which needs an iPhone, lives separately
off main - see the README.)

1. **Notion.** Create four databases and share them with a Notion
   integration: a rollup (one row per day, numeric columns per macro), a Log
   (one row per item; the column contract is in
   [FORMATTING.md](../FORMATTING.md)), and three workout databases (Push,
   Pull, Legs). Wire `POST /notion-webhook` as the webhook target so edits
   refresh the chart cache.
2. **Cloudflare.** Create one KV namespace; fill
   `worker/wrangler.toml.example` -> `wrangler.toml` (git-ignored).
3. **Env vars (plain text, on the worker):** `DATABASE_ID` (rollup),
   `NOTION_LOG_DB` (Log), `WORKOUT_DB_PUSH` / `WORKOUT_DB_PULL` /
   `WORKOUT_DB_LEGS`, `DAY_PAGES_JSON` (date -> Notion page URL map, used for
   day-popup deep links).
4. **Secrets:** `NOTION_TOKEN`, `GATE_PASSWORD`,
   `EMBED_TOKEN` (legacy - the live embed capability rotates via the
   `embed_token_v1` KV key described in
   [technical.md](technical.md#access-model)).
5. **CI secrets/vars:** `CF_API_TOKEN` + `CF_ACCOUNT_ID` (secrets) for the
   Deploy job; `SMOKE_K` (secret) + `SMOKE_BASE` (variable) for Smoke.
6. **Deploy.** Pushing runs Test (`node --check` + the feature guard)
   automatically. Deploy and Smoke run when you trigger the workflow
   manually from the Actions tab (choose "Run workflow") - `ci/deploy.sh`
   uploads the worker, then `ci/smoke.sh` and the feature guard fail red
   if user-facing features vanish from the served pages, so a silent
   feature rollback cannot ship. (The owner deploys his own production
   instance from the `feature/apple-health` branch instead.)

Cloudflare's free tier is nowhere near a constraint for one person's data.

An agent can drive this entire setup: creating the Notion databases, wiring
the worker bindings, running the deploy. Point it at this repo and at
[FORMATTING.md](../FORMATTING.md) and it picks up the logging conventions
automatically, photo-driven logging included.
