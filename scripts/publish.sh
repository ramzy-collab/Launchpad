#!/usr/bin/env bash
# Publish an app to Formelab with a deploy token.
#
#   export FORMELAB_TOKEN=fl_...        # from the dashboard; never printed by this script
#   export FORMELAB_DOMAIN=example.com  # or FORMELAB_URL=http://localhost:8787 for local dev
#   scripts/publish.sh --file app.html --namespace ramzy --path budget --title "Budget"
#
# Flags:
#   --file PATH           .html file or .zip with index.html at its root (required)
#   --namespace LABEL     namespace (subdomain) to publish into (required)
#   --path MOUNT          mount path, e.g. "budget" or "tools/budget"; default "" (namespace root)
#   --title TEXT          site title
#   --spa                 serve index.html for unknown extensionless paths
#   --visibility V        "all" (default) or "restricted"
#   --allowed-emails L    comma-separated allow-list for restricted sites
#   --dry-run             validate inputs and show what would be sent, without sending
set -euo pipefail

die() { echo "publish.sh: $*" >&2; exit 1; }

file="" namespace="" path="" title="" spa="" visibility="" allowed="" dry_run=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) file="${2-}"; shift 2 ;;
    --namespace) namespace="${2-}"; shift 2 ;;
    --path) path="${2-}"; shift 2 ;;
    --title) title="${2-}"; shift 2 ;;
    --spa) spa="true"; shift ;;
    --visibility) visibility="${2-}"; shift 2 ;;
    --allowed-emails) allowed="${2-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
done

[[ -n "$file" ]] || die "--file is required"
[[ -f "$file" ]] || die "file not found: $file"
[[ -n "$namespace" ]] || die "--namespace is required"
[[ "$namespace" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "invalid namespace: $namespace"
path="${path#/}"; path="${path%/}"
[[ -z "$path" || "$path" =~ ^[a-z0-9-]{1,63}(/[a-z0-9-]{1,63})*$ ]] || die "invalid --path: $path"
case "$file" in *.html|*.htm|*.zip|*.HTML|*.ZIP) ;; *) die "file must be .html or .zip" ;; esac
[[ -z "$visibility" || "$visibility" == "all" || "$visibility" == "restricted" ]] || die "--visibility must be all or restricted"
size=$(wc -c < "$file" | tr -d ' ')
(( size <= 25 * 1024 * 1024 )) || die "file is larger than 25 MB"

if [[ -n "${FORMELAB_URL:-}" ]]; then
  base="${FORMELAB_URL%/}"
elif [[ -n "${FORMELAB_DOMAIN:-}" ]]; then
  base="https://${FORMELAB_DOMAIN}"
else
  die "set FORMELAB_DOMAIN (e.g. example.com) or FORMELAB_URL"
fi
endpoint="$base/_api/deploy/sites"

form=(-F "file=@${file}" -F "namespace=${namespace}" -F "mount_path=${path}")
[[ -n "$title" ]] && form+=(-F "title=${title}")
[[ -n "$spa" ]] && form+=(-F "spa=true")
[[ -n "$visibility" ]] && form+=(-F "visibility=${visibility}")
[[ -n "$allowed" ]] && form+=(-F "allowed_emails=${allowed}")

if (( dry_run )); then
  echo "Dry run: would POST $endpoint"
  echo "  file:       $file ($size bytes)"
  echo "  namespace:  $namespace"
  echo "  mount_path: ${path:-(root)}"
  [[ -n "$title" ]] && echo "  title:      $title"
  [[ -n "$spa" ]] && echo "  spa:        true"
  [[ -n "$visibility" ]] && echo "  visibility: $visibility"
  [[ -n "$allowed" ]] && echo "  allowed:    $allowed"
  if [[ -n "${FORMELAB_TOKEN:-}" ]]; then echo "  token:      set (hidden)"; else echo "  token:      NOT SET"; fi
  exit 0
fi

[[ -n "${FORMELAB_TOKEN:-}" ]] || die "FORMELAB_TOKEN is not set (create one in the dashboard)"
[[ "$FORMELAB_TOKEN" =~ ^fl_[a-z2-7]+$ ]] || die "FORMELAB_TOKEN does not look like a deploy token"

# The token goes to curl on stdin (-K -), so it never appears in argv / `ps`.
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
status=$(printf 'header = "Authorization: Bearer %s"\n' "$FORMELAB_TOKEN" |
  curl -sS -K - -o "$tmp" -w '%{http_code}' "${form[@]}" "$endpoint") || die "request failed"

if [[ "$status" == 2* ]]; then
  url=$(sed -n 's/^{"url":"\([^"]*\)".*/\1/p' "$tmp")
  echo "Published: ${url:-$(cat "$tmp")}"
else
  echo "Publish failed (HTTP $status):" >&2
  cat "$tmp" >&2; echo >&2
  exit 1
fi
