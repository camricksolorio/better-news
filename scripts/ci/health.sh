#!/usr/bin/env bash
# Calls /api/health and fails on anything but 200, printing the checks (TDD "Workflow").
# Usage: APP_URL=... CRON_SECRET=... scripts/ci/health.sh
set -uo pipefail
body="$(mktemp)"
trap 'rm -f "$body"' EXIT
code="$(curl -sL -o "$body" -w '%{http_code}' -H "Authorization: Bearer ${CRON_SECRET}" "${APP_URL}/api/health")"
jq . "$body" 2>/dev/null || cat "$body"
if [ "$code" != "200" ]; then
  echo "::error::health returned HTTP $code"
  exit 1
fi
