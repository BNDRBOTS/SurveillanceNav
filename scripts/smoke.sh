#!/usr/bin/env bash
# End-to-end smoke test against a running STN instance (default localhost:4000).
# Exercises: SPA + PWA serving, auth (signup→login→refresh), assets (create→
# flag→dispute→evidence), FOIA (compose→create→send), procurement parse,
# exports (create→poll→signed download), admin metrics, security headers.
set -euo pipefail
BASE="${1:-http://localhost:4000}"
J="curl -fsS"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "✗ FAIL: $1"; }
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi }

EMAIL="smoke-$(date +%s)@stn.local"
PW="SmokeTest-2026!aa"

# --- static & meta ------------------------------------------------------
check "health/ready ok"                "$J $BASE/health/ready | grep -q '\"status\":\"ok\"'"
check "SPA served at /map"             "$J $BASE/map | grep -qi '<!doctype html>'"
check "manifest served"                "$J $BASE/manifest.webmanifest | grep -q 'Lens of Light'"
check "service worker served"          "$J $BASE/sw.js | grep -q 'stn-v1'"
check "openapi served"                 "$J $BASE/api/v1/openapi.json | grep -q '\"openapi\"'"
check "security headers present"       "curl -fsSI $BASE/api/v1/health/live | grep -qi 'content-security-policy'"
check "API 404 envelope"               "curl -s $BASE/api/v1/nope | grep -q '\"code\":\"not_found\"'"

# --- auth ----------------------------------------------------------------
SIGNUP=$(curl -fsS -X POST "$BASE/api/v1/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"name\":\"Smoke Tester\",\"password\":\"$PW\",\"consent\":{\"terms\":true,\"privacy\":true,\"researchContact\":false}}")
TOKEN=$(echo "$SIGNUP" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
[ -n "$TOKEN" ] && ok "signup issues access token" || bad "signup"
AUTH="Authorization: Bearer $TOKEN"

check "users/me"                       "$J -H '$AUTH' $BASE/api/v1/users/me | grep -q '$EMAIL'"
check "bad login rejected (401)"       "curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/v1/auth/login -H 'content-type: application/json' -d '{\"email\":\"$EMAIL\",\"password\":\"wrong-pass-123\"}' | grep -q 401"

WS=$(curl -fsS -H "$AUTH" "$BASE/api/v1/workspaces" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$WS" ] && ok "default workspace exists" || bad "workspace"

# --- assets ---------------------------------------------------------------
ASSET=$(curl -fsS -X POST "$BASE/api/v1/assets" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"Smoke ALPR — test corner","technologyType":"lpr","vendor":"Flock Safety","status":"unverified","lng":-122.4101,"lat":37.7801,"properties":{}}')
AID=$(echo "$ASSET" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$AID" ] && ok "asset created" || bad "asset create"
check "asset detail w/ confidence"     "$J $BASE/api/v1/assets/$AID | grep -q confidenceFactors"
check "geojson bbox query"             "$J '$BASE/api/v1/assets?format=geojson&bbox=-123,37,-122,38&zoom=12' | grep -q FeatureCollection"
check "server clustering at low zoom"  "$J '$BASE/api/v1/assets?format=geojson&bbox=-130,25,-65,50&zoom=4' | grep -q '\"clustered\":true'"
check "nearby with distances"          "$J '$BASE/api/v1/assets/nearby?lng=-122.41&lat=37.78&radiusMeters=2000' | grep -q distanceMeters"
check "flag asset"                     "curl -fsS -X POST $BASE/api/v1/assets/$AID/flag -H '$AUTH' -H 'content-type: application/json' -d '{\"reason\":\"smoke test flag\"}' | grep -q flagId"
check "dispute asset"                  "curl -fsS -X POST $BASE/api/v1/assets/$AID/dispute -H '$AUTH' -H 'content-type: application/json' -d '{\"reason\":\"smoke\",\"evidence\":\"Smoke-test dispute body with enough characters.\"}' | grep -q disputeId"
check "malformed bbox → 422"           "curl -s -o /dev/null -w '%{http_code}' '$BASE/api/v1/assets?bbox=garbage' | grep -q 422"
check "evidence upload (txt)"          "curl -fsS -X POST $BASE/api/v1/assets/$AID/evidence -H '$AUTH' -F 'file=@/etc/hostname;type=text/plain' | grep -q evidenceId"

# --- FOIA -----------------------------------------------------------------
TPL=$(curl -fsS "$BASE/api/v1/foia/templates" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
JUR=$(curl -fsS "$BASE/api/v1/jurisdictions?q=San%20Francisco" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
COMPOSE=$(curl -fsS -X POST "$BASE/api/v1/foia/compose" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"templateId\":\"$TPL\",\"jurisdictionId\":\"$JUR\"}")
echo "$COMPOSE" | grep -q "Public Records Act" && ok "FOIA compose cites statute" || bad "FOIA compose"
FOIA=$(curl -fsS -X POST "$BASE/api/v1/foia" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"jurisdictionId\":\"$JUR\",\"subject\":\"Smoke FOIA\",\"body\":\"Test request body content.\"}")
FID=$(echo "$FOIA" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
SENT=$(curl -fsS -X PATCH "$BASE/api/v1/foia/$FID" -H "$AUTH" -H 'content-type: application/json' -d '{"status":"sent"}')
echo "$SENT" | grep -q '"dueAt":"' && ok "FOIA sent → statutory due date computed" || bad "FOIA due date"

# --- procurement ------------------------------------------------------------
PROC=$(curl -fsS -X POST "$BASE/api/v1/procurement/parse" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"title":"Smoke contract","text":"Contract awarded to Flock Safety for a total amount not to exceed $250,000.00 covering automated license plate reader cameras. Term: March 1, 2026 through 2028-02-28."}')
echo "$PROC" | grep -q jobId && ok "procurement parse queued" || bad "procurement parse"
PID2=$(echo "$PROC" | grep -o '"procurementId":"[^"]*"' | cut -d'"' -f4)
for i in $(seq 1 20); do
  V=$(curl -fsS "$BASE/api/v1/procurements/$PID2" | grep -o '"vendor":"[^"]*"' | head -1 || true)
  [ -n "$V" ] && break; sleep 1
done
echo "$V" | grep -q "Flock Safety" && ok "procurement vendor extracted async" || bad "procurement extraction ($V)"

# --- exports -----------------------------------------------------------------
EXP=$(curl -fsS -X POST "$BASE/api/v1/exports" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"format":"csv","resource":"assets","params":{}}')
EID=$(echo "$EXP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
for i in $(seq 1 25); do
  STATUS=$(curl -fsS -H "$AUTH" "$BASE/api/v1/exports/$EID")
  echo "$STATUS" | grep -q '"status":"completed"' && break; sleep 1
done
DL=$(echo "$STATUS" | grep -o '"downloadUrl":"[^"]*"' | cut -d'"' -f4 | sed 's/\\u0026/\&/g')
[ -n "$DL" ] && ok "export completed with signed URL" || bad "export"
# grep -c (not -q) reads to EOF — avoids SIGPIPE→curl failure under pipefail
check "signed download works"          "$J '$BASE$DL' | grep -c technology_type >/dev/null"
check "tampered signature rejected"    "curl -s -o /dev/null -w '%{http_code}' '$BASE$(echo "$DL" | sed 's/sig=./sig=X/')' | grep -q 403"

# --- notifications & idempotency ---------------------------------------------
check "notifications endpoint"         "$J -H '$AUTH' $BASE/api/v1/users/me/notifications | grep -q unread"
IKEY="smoke-idem-$(date +%s)"
R1=$(curl -fsS -X POST "$BASE/api/v1/assets" -H "$AUTH" -H "Idempotency-Key: $IKEY" -H 'content-type: application/json' -d '{"name":"Idem smoke","technologyType":"cctv","lng":-100,"lat":40,"properties":{}}')
R2=$(curl -fsS -X POST "$BASE/api/v1/assets" -H "$AUTH" -H "Idempotency-Key: $IKEY" -H 'content-type: application/json' -d '{"name":"Idem smoke","technologyType":"cctv","lng":-100,"lat":40,"properties":{}}')
[ "$(echo "$R1" | grep -o '"id":"[^"]*"' | head -1)" = "$(echo "$R2" | grep -o '"id":"[^"]*"' | head -1)" ] \
  && ok "idempotent replay returns same record" || bad "idempotency"

echo
echo "SMOKE RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
