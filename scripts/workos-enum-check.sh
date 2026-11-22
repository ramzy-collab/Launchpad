#!/usr/bin/env bash
# Staging check: does WorkOS answer differently for emails with and without an account?
#
# Calls WorkOS directly (not Formelab) for each kind of test account, several times each, and prints
# a table of status, error code, message and median time per account kind and call, plus answers to
# the three questions in the sign-in enumeration fix (see the PR that added this script).
#
# Needs: bash, curl, jq. A WorkOS *test* environment key (sk_test_...), never production.
#
# Set up the accounts in the WorkOS staging environment first, then:
#
#   export WORKOS_API_KEY=sk_test_...  WORKOS_CLIENT_ID=client_...
#   export EMAIL_PASSWORD=...        # existing user with a password
#   export EMAIL_NO_PASSWORD=...     # existing user with no password
#   export EMAIL_UNVERIFIED=...      # existing user with a password, email not verified
#   export EMAIL_MFA=...             # existing user with a password, enrolled in MFA
#   export EMAIL_UNKNOWN_OWNED=...   # no user, on a domain you own (codes really arrive there)
#   export EMAIL_UNKNOWN_SSO=...     # no user, on a domain with an SSO policy
#   export EMAIL_UNKNOWN_INVALID=... # no user, at x.invalid (default: enum-check@x.invalid)
#   scripts/workos-enum-check.sh signup-on    # with "Sign up" on in the WorkOS dashboard
#   scripts/workos-enum-check.sh signup-off   # then again with it off
#
# Options (environment): RUNS (default 10), GAP seconds between calls for one email (default 21,
# WorkOS allows 3 codes a minute per email), OUT directory (default ./workos-enum-<label>-<time>).
#
# Takes about RUNS x 4 x GAP seconds (about 14 minutes with the defaults). Sends real code emails to
# the existing accounts and to EMAIL_UNKNOWN_OWNED. If sending a code creates a user for an unknown
# email, the script records it and deletes that user (and only that one), so the next run still
# tests an email with no account.
set -euo pipefail
(( BASH_VERSINFO[0] >= 4 )) || { echo "Needs bash 4 or later (on a Mac: brew install bash, then run it with that bash)." >&2; exit 2; }

label="${1:-}"
[[ "$label" =~ ^[a-z0-9-]+$ ]] || { echo "Usage: $0 <label, e.g. signup-on or signup-off>" >&2; exit 2; }
: "${WORKOS_API_KEY:?Set WORKOS_API_KEY (a sk_test_ key)}" "${WORKOS_CLIENT_ID:?Set WORKOS_CLIENT_ID}"
[[ "$WORKOS_API_KEY" == sk_test_* ]] || { echo "Refusing: WORKOS_API_KEY isn't a test key (sk_test_...)." >&2; exit 2; }
for tool in curl jq awk; do command -v "$tool" >/dev/null || { echo "Needs $tool." >&2; exit 2; }; done

RUNS="${RUNS:-10}"
GAP="${GAP:-21}"
API="${WORKOS_API_BASE:-https://api.workos.com}" # override only to try the script against a stand-in
OUT="${OUT:-./workos-enum-$label-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT/bodies"
RESULTS="$OUT/results.tsv"
printf 'kind\tcall\trun\tstatus\tcode\tmessage\ttime\n' >"$RESULTS"

# Kind of account → email. Known kinds have a user; unknown_* kinds must not.
declare -A EMAIL=(
  [password]="${EMAIL_PASSWORD:?Set EMAIL_PASSWORD}"
  [no_password]="${EMAIL_NO_PASSWORD:?Set EMAIL_NO_PASSWORD}"
  [unverified]="${EMAIL_UNVERIFIED:?Set EMAIL_UNVERIFIED}"
  [mfa]="${EMAIL_MFA:?Set EMAIL_MFA}"
  [unknown_owned]="${EMAIL_UNKNOWN_OWNED:?Set EMAIL_UNKNOWN_OWNED}"
  [unknown_invalid]="${EMAIL_UNKNOWN_INVALID:-enum-check@x.invalid}"
  [unknown_sso]="${EMAIL_UNKNOWN_SSO:?Set EMAIL_UNKNOWN_SSO}"
)
KINDS=(password no_password unverified mfa unknown_owned unknown_invalid unknown_sso)
declare -A LAST=()

auth=(-H "Authorization: Bearer $WORKOS_API_KEY")
json=(-H "Content-Type: application/json")

# The id of the user with this email, or "" when there is none.
user_id() {
  curl -sS "${auth[@]}" --get --data-urlencode "email=$1" "$API/user_management/users" | jq -r '.data[0].id // ""'
}

# Seconds since 1970 with a fraction where bash has it (bash 5), whole seconds otherwise.
clock() { echo "${EPOCHREALTIME:-$(date +%s)}"; }

# Waits until GAP seconds have passed since the last call for this kind's email.
pace() {
  local kind="$1" now wait
  if [[ -n "${LAST[$kind]:-}" ]]; then
    now=$(clock)
    wait=$(awk -v l="${LAST[$kind]}" -v n="$now" -v g="$GAP" 'BEGIN { w = g - (n - l); print (w > 0 ? w : 0) }')
    sleep "$wait"
  fi
  LAST[$kind]=$(clock)
}

# POSTs JSON to a WorkOS path and records one result row. Never records a one-time code.
record() {
  local kind="$1" call="$2" run="$3" path="$4" payload="$5" body="$OUT/bodies/$kind-$call-$run.json" meta status time code message
  # A network failure is recorded as status 000 rather than ending the whole run.
  meta=$(curl -sS -o "$body" -w '%{http_code} %{time_total}' "${json[@]}" "${auth[@]}" -d "$payload" "$API$path") || meta="000 -"
  status="${meta% *}"
  time="${meta#* }"
  # A successful send-code answer carries the code itself in "code": blank it in the saved body too.
  if [[ "$status" != 000 && "$status" -lt 300 ]]; then
    code="-"
    message="-"
    jq 'if type == "object" and has("code") then .code = "[redacted]" else . end' "$body" >"$body.tmp" 2>/dev/null && mv "$body.tmp" "$body" || true
  else
    code=$(jq -r '.code // .error // "-"' "$body" 2>/dev/null || echo "-")
    message=$(jq -r '(.errors[0].message // .message // .error_description // "-") | gsub("[\t\n]"; " ")' "$body" 2>/dev/null || echo "-")
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$call" "$run" "$status" "$code" "$message" "$time" >>"$RESULTS"
}

# Before anything: the unknown emails must not have users yet, and the known ones must.
for kind in "${KINDS[@]}"; do
  id=$(user_id "${EMAIL[$kind]}")
  if [[ "$kind" == unknown_* && -n "$id" ]]; then echo "Stop: ${EMAIL[$kind]} ($kind) already has a user ($id). Pick another email." >&2; exit 1; fi
  if [[ "$kind" != unknown_* && -z "$id" ]]; then echo "Stop: ${EMAIL[$kind]} ($kind) has no user. Create it first." >&2; exit 1; fi
done

created_users=0
echo "Label $label: $RUNS runs, $GAP s between calls per email. Results in $OUT."
for run in $(seq 1 "$RUNS"); do
  for call in send_code wrong_password wrong_code; do
    for kind in "${KINDS[@]}"; do
      email="${EMAIL[$kind]}"
      pace "$kind"
      case "$call" in
        send_code)
          record "$kind" send_code "$run" /user_management/magic_auth "$(jq -nc --arg e "$email" '{email: $e}')"
          # Did sending a code create a user for an email without one?
          if [[ "$kind" == unknown_* ]]; then
            id=$(user_id "$email")
            printf '%s\tusers_lookup\t%s\t-\t%s\t-\t-\n' "$kind" "$run" "$([[ -n "$id" ]] && echo created || echo none)" >>"$RESULTS"
            if [[ -n "$id" ]]; then
              created_users=$((created_users + 1))
              curl -sS -o /dev/null -X DELETE "${auth[@]}" "$API/user_management/users/$id"
            fi
          fi
          ;;
        wrong_password)
          record "$kind" wrong_password "$run" /user_management/authenticate \
            "$(jq -nc --arg c "$WORKOS_CLIENT_ID" --arg s "$WORKOS_API_KEY" --arg e "$email" '{client_id: $c, client_secret: $s, grant_type: "password", email: $e, password: "wrong-pass-123"}')"
          ;;
        wrong_code)
          record "$kind" wrong_code "$run" /user_management/authenticate \
            "$(jq -nc --arg c "$WORKOS_CLIENT_ID" --arg s "$WORKOS_API_KEY" --arg e "$email" '{client_id: $c, client_secret: $s, grant_type: "urn:workos:oauth:grant-type:magic-auth:code", email: $e, code: "000000"}')"
          ;;
      esac
    done
  done
  echo "Run $run of $RUNS done."
done

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

# One row per kind and call: every status/code seen (with counts), the messages, the median time.
summary() {
  awk -F'\t' -v call="$1" '
    NR > 1 && $2 == call {
      k = $1; kinds[k] = 1
      seen[k] = seen[k] (index(seen[k], "|" $4 " " $5 "|") ? "" : "|" $4 " " $5 "|")
      n[k, $4 " " $5]++
      if (!((k, $6) in msg)) { msg[k, $6] = 1; msgs[k] = msgs[k] (msgs[k] ? " / " : "") $6 }
      if ($7 != "-") t[k, ++tn[k]] = $7
    }
    END {
      order = "password no_password unverified mfa unknown_owned unknown_invalid unknown_sso"
      split(order, ks, " ")
      for (i = 1; i <= 7; i++) {
        k = ks[i]; if (!(k in kinds)) continue
        out = ""; m = split(seen[k], parts, "|")
        for (j = 1; j <= m; j++) if (parts[j] != "") out = out (out ? ", " : "") parts[j] " x" n[k, parts[j]]
        # median of the times
        c = tn[k]; for (a = 1; a <= c; a++) v[a] = t[k, a]
        for (a = 1; a <= c; a++) for (b = a + 1; b <= c; b++) if (v[b] < v[a]) { x = v[a]; v[a] = v[b]; v[b] = x }
        med = c ? (c % 2 ? v[(c + 1) / 2] : (v[c / 2] + v[c / 2 + 1]) / 2) : 0
        printf "| %s | %s | %s | %s |\n", k, out, msgs[k], (c ? sprintf("%.3f s", med) : "-")
      }
    }' "$RESULTS"
}

report="$OUT/report.md"
{
  echo "# WorkOS enumeration check: $label"
  echo
  echo "$RUNS runs per account kind and call, $GAP s apart per email. $(date -u +%Y-%m-%dT%H:%MZ)."
  for call in send_code wrong_password wrong_code; do
    echo
    echo "## $call"
    echo
    echo "| Account kind | Status and code (times seen) | Message | Median time |"
    echo "|---|---|---|---|"
    summary "$call"
  done
  echo
  echo "## Did sending a code create a user for an unknown email?"
  echo
  awk -F'\t' 'NR > 1 && $2 == "users_lookup" { c[$1 " " $5]++ } END { for (k in c) print "- " k " x" c[k] }' "$RESULTS" | sort
  echo
  echo "## Answers"
  echo
  # Q1: redirect codes on a WRONG password.
  redirects='email_verification_required|mfa_enrollment|mfa_challenge|mfa_verification|sso_required|organization_selection_required|radar_email_challenge|radar_sms_challenge|radar_challenge|radar_sign_up_challenge|radar_sms_sign_in_challenge'
  q1=$(awk -F'\t' -v re="^($redirects)$" 'NR > 1 && $2 == "wrong_password" && ($1 == "unverified" || $1 == "mfa") && $5 ~ re { print $1 ": " $5 }' "$RESULTS" | sort -u)
  if [[ -n "$q1" ]]; then
    echo "1. **Yes: a redirect code came back with the WRONG password**, so those redirects tell a visitor the account exists:"
    echo "$q1" | sed 's/^/   - /'
  else
    echo "1. No: the unverified and MFA users got no redirect code with a wrong password."
  fi
  # Q2: wrong-code answers for unknown emails vs known ones.
  known_codes=$(awk -F'\t' 'NR > 1 && $2 == "wrong_code" && $1 !~ /^unknown_/ { print $4 " " $5 }' "$RESULTS" | sort -u | paste -sd, -)
  unknown_codes=$(awk -F'\t' 'NR > 1 && $2 == "wrong_code" && $1 ~ /^unknown_/ { print $4 " " $5 }' "$RESULTS" | sort -u | paste -sd, -)
  if [[ "$known_codes" == "$unknown_codes" ]]; then
    echo "2. No difference from the wrong-code call: known and unknown emails both got $known_codes."
  else
    echo "2. **Different answers from the wrong-code call.** Known emails: $known_codes. Unknown emails: $unknown_codes."
  fi
  # Q3: timing. Medians for known vs unknown per call; flags a gap over 30% and 50 ms.
  echo "3. Timing (median of all known vs all unknown emails):"
  for call in send_code wrong_password wrong_code; do
    awk -F'\t' -v call="$call" '
      function med(arr, n,   a, b, x) { for (a = 1; a <= n; a++) for (b = a + 1; b <= n; b++) if (arr[b] < arr[a]) { x = arr[a]; arr[a] = arr[b]; arr[b] = x }
        return n ? (n % 2 ? arr[(n + 1) / 2] : (arr[n / 2] + arr[n / 2 + 1]) / 2) : 0 }
      NR > 1 && $2 == call && $7 != "-" { if ($1 ~ /^unknown_/) u[++nu] = $7; else k[++nk] = $7 }
      END {
        mk = med(k, nk); mu = med(u, nu); d = mu - mk; if (d < 0) d = -d
        gap = (d > 0.05 && d > 0.3 * (mk < mu ? mk : mu))
        printf "   - %s: known %.3f s, unknown %.3f s%s\n", call, mk, mu, gap ? " (**consistent gap: worth a closer look**)" : ""
      }' "$RESULTS"
  done
  echo
  echo "Users created and deleted by this run: $created_users. Raw answers (one-time codes blanked): $OUT/bodies, rows: $RESULTS."
} >"$report"

cat "$report"
