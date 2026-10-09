#!/usr/bin/env bash
# Calls /api/<stage> repeatedly until it reports remaining = 0 (TDD "Workflow").
# Usage: APP_URL=... CRON_SECRET=... scripts/ci/run-stage.sh embed|cluster
#   409 busy        -> a notice, exit 0 (another run holds the lease)
#   other non-2xx   -> exit 1
#   no progress     -> stop (a stuck row would otherwise be retried every iteration); exit 1 if rows failed
#   iteration cap   -> a warning, exit 0 (the backlog health check catches a real pile-up)
set -uo pipefail

stage="${1:?usage: run-stage.sh embed|cluster}"
max="${MAX_ITERATIONS:-50}"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT

for ((i = 1; i <= max; i++)); do
  # -f is not used so the status code and body are available; -L follows redirects like the ingest step.
  code="$(curl -sL -o "$body" -w '%{http_code}' -H "Authorization: Bearer ${CRON_SECRET}" "${APP_URL}/api/${stage}")"
  case "$code" in
    200)
      echo "[$stage #$i] $(cat "$body")"
      remaining="$(jq -r '.remaining' "$body")"
      processed="$(jq -r '.processed' "$body")"
      failed="$(jq -r '.failed' "$body")"
      if [ "$remaining" = "0" ]; then exit 0; fi
      if [ "$processed" = "0" ]; then
        if [ "$failed" != "0" ]; then
          echo "::error::$stage made no progress: $failed failed, $remaining remaining"
          exit 1
        fi
        echo "::warning::$stage made no progress with $remaining remaining; stopping"
        exit 0
      fi
      ;;
    409)
      echo "::notice::$stage is busy (another run holds the lease); skipping"
      exit 0
      ;;
    *)
      echo "::error::$stage returned HTTP $code: $(head -c 500 "$body")"
      exit 1
      ;;
  esac
done

echo "::warning::$stage still has work remaining after $max iterations"
exit 0
