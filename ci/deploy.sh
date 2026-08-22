#!/usr/bin/env bash
# Deploy worker/worker.js to the cbum-chart Cloudflare Worker.
# Mirrors the manual recipe: pull current settings first so no binding
# (KV, D1, plain_text vars, compat date) is dropped, then multipart-PUT
# the script + merged metadata. secret_text bindings are EXCLUDED from the
# PUT: including them without their values errors (10021), and Cloudflare
# keeps existing worker secrets implicitly across uploads.
set -euo pipefail
: "${CF_API_TOKEN:?missing}"; : "${CF_ACCOUNT_ID:?missing}"
API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/cbum-chart"
AUTH="Authorization: Bearer ${CF_API_TOKEN}"

settings=$(curl -fsS "$API/settings" -H "$AUTH")
python3 - "$settings" > /tmp/metadata.json <<'PY'
import json, sys
r = json.loads(sys.argv[1])["result"]
meta = {
    "main_module": "worker.js",
    "compatibility_date": r.get("compatibility_date", "2024-11-01"),
    "bindings": [b for b in r.get("bindings", []) if b.get("type") != "secret_text"],
}
for opt in ("compatibility_flags", "usage_model", "logpush", "tail_consumers", "placement", "observability"):
    if r.get(opt) not in (None, [], {}):
        meta[opt] = r[opt]
print(json.dumps(meta))
PY
echo "metadata: $(python3 -c 'import json;m=json.load(open("/tmp/metadata.json"));print("compat",m["compatibility_date"],"bindings",len(m["bindings"]))')"

for attempt in 1 2 3; do
  resp=$(curl -sS -X PUT "$API" -H "$AUTH" \
    -F "worker.js=@worker/worker.js;type=application/javascript+module" \
    -F "metadata=@/tmp/metadata.json;type=application/json")
  ok=$(printf '%s' "$resp" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("success"))' 2>/dev/null || echo "False")
  [ "$ok" = "True" ] && { echo "deploy: upload success"; break; }
  echo "deploy attempt $attempt failed: $(printf '%s' "$resp" | head -c 300)"
  [ $attempt = 3 ] && exit 1
  sleep 10
done

curl -fsS "$API/deployments" -H "$AUTH" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d.get("success"), d
deps = d["result"]["deployments"]
assert deps, "no deployments recorded"
print("deployments:", [(x.get("number"), x.get("version_id", "")[:8]) for x in deps][:3])
'
