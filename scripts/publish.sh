#!/usr/bin/env bash
# Publish an app to Formelab with a deploy token.
#
#   export FORMELAB_TOKEN=fl_...        # from the dashboard; never printed by this script
#   export FORMELAB_DOMAIN=example.com  # or FORMELAB_URL=http://localhost:8787 for local dev
#   scripts/publish.sh --file app.html --namespace ramzy --path budget --title "Budget"
#   scripts/publish.sh --dir dist --changed-only --namespace ramzy --path budget
#
# Flags:
#   --file PATH           .html file or .zip with index.html at its root
#   --dir PATH            a folder with index.html at its top (zipped for you; needs `zip`)
#   --changed-only        with --dir: upload only the files that differ from the live app, and
#                         remove the ones that are gone; the rest stay as they are (fast for big apps)
#   --namespace LABEL     namespace (subdomain) to publish into (required)
#   --path MOUNT          mount path, e.g. "budget" or "tools/budget"; default "" (namespace root)
#   --title TEXT          site title
#   --spa                 serve index.html for unknown extensionless paths
#   --visibility V        "all" (default) or "restricted"
#   --allowed-emails L    comma-separated allow-list for restricted sites
#   --dry-run             validate inputs and show what would be sent, without sending
set -euo pipefail
export LC_ALL=C # stable sort order for comm

die() { echo "publish.sh: $*" >&2; exit 1; }

file="" dir="" changed_only=0 namespace="" path="" title="" spa="" visibility="" allowed="" dry_run=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) file="${2-}"; shift 2 ;;
    --dir) dir="${2-}"; shift 2 ;;
    --changed-only) changed_only=1; shift ;;
    --namespace) namespace="${2-}"; shift 2 ;;
    --path) path="${2-}"; shift 2 ;;
    --title) title="${2-}"; shift 2 ;;
    --spa) spa="true"; shift ;;
    --visibility) visibility="${2-}"; shift 2 ;;
    --allowed-emails) allowed="${2-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
done

[[ -n "$file" || -n "$dir" ]] || die "--file or --dir is required"
[[ -z "$file" || -z "$dir" ]] || die "use --file or --dir, not both"
(( ! changed_only )) || [[ -n "$dir" ]] || die "--changed-only needs --dir"
tmpdir="$(mktemp -d)"; trap 'rm -rf "$tmpdir"' EXIT
if [[ -n "$dir" ]]; then
  [[ -d "$dir" ]] || die "folder not found: $dir"
  [[ -f "$dir/index.html" ]] || die "no index.html at the top of $dir"
  command -v zip >/dev/null || die "--dir needs the zip command"
  dir="$(cd "$dir" && pwd)"
  file="$tmpdir/app.zip"
fi
[[ -n "$dir" || -f "$file" ]] || die "file not found: $file"
[[ -n "$namespace" ]] || die "--namespace is required"
[[ "$namespace" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "invalid namespace: $namespace"
path="${path#/}"; path="${path%/}"
[[ -z "$path" || "$path" =~ ^[a-z0-9-]{1,63}(/[a-z0-9-]{1,63})*$ ]] || die "invalid --path: $path"
case "$file" in *.html|*.htm|*.zip|*.HTML|*.ZIP) ;; *) die "file must be .html or .zip" ;; esac
[[ -z "$visibility" || "$visibility" == "all" || "$visibility" == "restricted" ]] || die "--visibility must be all or restricted"

if [[ -n "${FORMELAB_URL:-}" ]]; then
  base="${FORMELAB_URL%/}"
elif [[ -n "${FORMELAB_DOMAIN:-}" ]]; then
  base="https://${FORMELAB_DOMAIN}"
else
  die "set FORMELAB_DOMAIN (e.g. example.com) or FORMELAB_URL"
fi
endpoint="$base/_api/deploy/sites"

# Sends the token to curl on stdin (-K -), so it never appears in argv / `ps`.
api() {
  printf 'header = "Authorization: Bearer %s"\n' "$FORMELAB_TOKEN" | curl -sS -K - "$@"
}
need_token() {
  [[ -n "${FORMELAB_TOKEN:-}" ]] || die "FORMELAB_TOKEN is not set (create one in the dashboard)"
  [[ "$FORMELAB_TOKEN" =~ ^fl_[a-z2-7]+$ ]] || die "FORMELAB_TOKEN does not look like a deploy token"
}

# "<sha256>  <path>" for every file in the folder, sorted by path.
local_hashes() {
  if command -v sha256sum >/dev/null; then hash=(sha256sum); else hash=(shasum -a 256); fi
  (cd "$dir" && find . -type f ! -name .DS_Store ! -path './.git/*' -print0 | xargs -0 "${hash[@]}" | sed 's|  \./|  |' | sort -k2)
}

merge="" deletes="" upload=1
if [[ -n "$dir" ]] && (( changed_only )) && (( ! dry_run )); then
  need_token
  q="namespace=${namespace}&mount_path=${path}&format=sha256sum"
  status=$(api -o "$tmpdir/remote" -w '%{http_code}' "$endpoint/manifest?$q") || die "request failed"
  if [[ "$status" == 200 ]]; then
    local_hashes > "$tmpdir/local"
    # Files whose hash the live app doesn't have (new or changed), and live files no longer here.
    changed=$(sort "$tmpdir/remote" | comm -23 <(sort "$tmpdir/local") - | sed 's/^[0-9a-f]*  //')
    remote_paths=$(sed 's/^[0-9a-f]*  //' "$tmpdir/remote" | sort)
    deletes=$(comm -13 <(sed 's/^[0-9a-f]*  //' "$tmpdir/local" | sort) <(printf '%s\n' "$remote_paths" | sed '/^$/d'))
    if [[ -z "$changed" && -z "$deletes" ]]; then echo "Nothing changed; the live app is up to date."; exit 0; fi
    merge=1
    echo "Changed: $(printf '%s\n' "$changed" | sed '/^$/d' | wc -l | tr -d ' ') file(s); removed: $(printf '%s\n' "$deletes" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [[ -n "$changed" ]]; then
      (cd "$dir" && printf '%s\n' "$changed" | zip -q -X "$file" -@) || die "zip failed"
    else
      upload=0
    fi
  elif [[ "$status" == 404 ]]; then
    echo "No live app there yet; uploading everything."
  else
    echo "Could not read the live app (HTTP $status); uploading everything." >&2
  fi
fi
if [[ -n "$dir" && -z "$merge" ]]; then
  (cd "$dir" && find . -type f ! -name .DS_Store ! -path './.git/*' | sed 's|^\./||' | zip -q -X "$file" -@) || die "zip failed"
fi
if (( upload )); then
  size=$(wc -c < "$file" | tr -d ' ')
  (( size <= 25 * 1024 * 1024 )) || die "upload is larger than 25 MB"
fi

# --form-string: with -F, a value starting with @ or < makes curl read a local file (audit finding #12).
form=(--form-string "namespace=${namespace}" --form-string "mount_path=${path}")
(( upload )) && form+=(-F "file=@${file}")
[[ -n "$merge" ]] && form+=(-F "merge=true")
[[ -n "$deletes" ]] && form+=(--form-string "delete=${deletes}")
[[ -n "$title" ]] && form+=(--form-string "title=${title}")
[[ -n "$spa" ]] && form+=(-F "spa=true")
[[ -n "$visibility" ]] && form+=(--form-string "visibility=${visibility}")
[[ -n "$allowed" ]] && form+=(--form-string "allowed_emails=${allowed}")

if (( dry_run )); then
  echo "Dry run: would POST $endpoint"
  if [[ -n "$dir" ]]; then echo "  folder:     $dir$( (( changed_only )) && echo ' (changed files only)')"; else echo "  file:       $file ($size bytes)"; fi
  echo "  namespace:  $namespace"
  echo "  mount_path: ${path:-(root)}"
  [[ -n "$title" ]] && echo "  title:      $title"
  [[ -n "$spa" ]] && echo "  spa:        true"
  [[ -n "$visibility" ]] && echo "  visibility: $visibility"
  [[ -n "$allowed" ]] && echo "  allowed:    $allowed"
  if [[ -n "${FORMELAB_TOKEN:-}" ]]; then echo "  token:      set (hidden)"; else echo "  token:      NOT SET"; fi
  exit 0
fi

need_token
tmp="$tmpdir/response"
status=$(api -o "$tmp" -w '%{http_code}' "${form[@]}" "$endpoint") || die "request failed"

if [[ "$status" == 2* ]]; then
  url=$(sed -n 's/^{"url":"\([^"]*\)".*/\1/p' "$tmp")
  echo "Published: ${url:-$(cat "$tmp")}"
else
  echo "Publish failed (HTTP $status):" >&2
  cat "$tmp" >&2; echo >&2
  exit 1
fi
