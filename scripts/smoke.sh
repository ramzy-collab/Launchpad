#!/usr/bin/env bash
# Smoke test: publish a canary app, fetch it, delete it, and confirm it is gone.
#
#   export FORMELAB_TOKEN=fl_...          # deploy token (never printed)
#   export FORMELAB_DOMAIN=example.com    # or FORMELAB_URL=http://localhost:8787 for local dev
#   export FORMELAB_NAMESPACE=ramzy       # a namespace you own
#   scripts/smoke.sh
#
# Fetching the canary in production goes through Cloudflare Access, so the script needs a
# user JWT for the app: it uses FORMELAB_ACCESS_JWT if set, otherwise tries
# `cloudflared access token -app=https://<ns>.<domain>` (run `cloudflared access login` first).
set -euo pipefail

die() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok   $*"; }

[[ -n "${FORMELAB_TOKEN:-}" ]] || die "FORMELAB_TOKEN is not set"
[[ -n "${FORMELAB_NAMESPACE:-}" ]] || die "FORMELAB_NAMESPACE is not set"
if [[ -n "${FORMELAB_URL:-}" ]]; then base="${FORMELAB_URL%/}"
elif [[ -n "${FORMELAB_DOMAIN:-}" ]]; then base="https://${FORMELAB_DOMAIN}"
else die "set FORMELAB_DOMAIN or FORMELAB_URL"; fi
ns="$FORMELAB_NAMESPACE"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# Authenticated curl against the deploy API; the token is passed on stdin, never in argv.
api() {
  printf 'header = "Authorization: Bearer %s"\n' "$FORMELAB_TOKEN" |
    curl -sS -K - -o "$tmp/body" -w '%{http_code}' "$@"
}
json_field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$tmp/body" | head -1; }

# 1. Token works.
code=$(api "$base/_api/deploy/whoami") || die "cannot reach $base"
[[ "$code" == 200 ]] || die "whoami returned HTTP $code: $(cat "$tmp/body")"
ok "token is valid for $(json_field email)"

# 2. Publish a canary.
marker="formelab-smoke-$(date +%s)-$RANDOM"
mount="smoke-$(date +%s)"
printf '<!doctype html><html><head><title>smoke</title></head><body><p id="m">%s</p></body></html>' "$marker" > "$tmp/canary.html"
code=$(api -F "file=@$tmp/canary.html" -F "namespace=$ns" -F "mount_path=$mount" -F "title=Smoke canary" "$base/_api/deploy/sites")
[[ "$code" == 201 ]] || die "publish returned HTTP $code: $(cat "$tmp/body")"
url=$(json_field url); site_id=$(json_field id)
[[ -n "$url" && -n "$site_id" ]] || die "publish response missing url or id: $(cat "$tmp/body")"
ok "published $url"

cleanup() { api -X DELETE "$base/_api/deploy/sites/$site_id" >/dev/null 2>&1 || true; }
trap 'cleanup; rm -rf "$tmp"' EXIT

# 3. It shows up in the listing.
code=$(api "$base/_api/deploy/sites?namespace=$ns")
[[ "$code" == 200 ]] && grep -q "\"$site_id\"" "$tmp/body" || die "canary missing from list_sites"
ok "listed in namespace $ns"

# 4. Fetch it (through Access in production).
jwt="${FORMELAB_ACCESS_JWT:-}"
host=$(printf '%s' "$url" | sed -E 's#^https?://([^/:]+).*#\1#')
if [[ -z "$jwt" && "$base" == https://* ]] && command -v cloudflared >/dev/null; then
  jwt=$(cloudflared access token -app="https://$host" 2>/dev/null || true)
fi
fetch() {
  if [[ -n "$jwt" ]]; then
    printf 'header = "cf-access-token: %s"\n' "$jwt" | curl -sS -K - -o "$tmp/page" -w '%{http_code}' "$url"
  else
    curl -sS -o "$tmp/page" -w '%{http_code}' "$url"
  fi
}
can_fetch=1
if [[ "$base" == https://* && -z "$jwt" ]]; then
  can_fetch=0
  echo "skip fetch: no Access JWT (set FORMELAB_ACCESS_JWT or install cloudflared and run 'cloudflared access login https://$host')"
fi
if (( can_fetch )); then
  code=$(fetch)
  [[ "$code" == 200 ]] || die "fetching the canary returned HTTP $code"
  grep -q "$marker" "$tmp/page" || die "canary page did not contain the marker"
  grep -q "<base href=\"/$mount/\">" "$tmp/page" || die "canary page is missing the injected <base>"
  ok "fetched canary with marker and <base>"
fi

# 5. Delete it and confirm it's gone.
code=$(api -X DELETE "$base/_api/deploy/sites/$site_id")
[[ "$code" == 200 ]] || die "delete returned HTTP $code: $(cat "$tmp/body")"
trap 'rm -rf "$tmp"' EXIT
code=$(api "$base/_api/deploy/sites?namespace=$ns")
grep -q "\"$site_id\"" "$tmp/body" && die "canary still listed after delete"
if (( can_fetch )); then
  code=$(fetch)
  [[ "$code" == 404 ]] || die "deleted canary returned HTTP $code (expected 404)"
fi
ok "deleted canary"
echo "SMOKE TEST PASSED"
