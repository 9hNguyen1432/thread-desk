#!/usr/bin/env bash
# Fails when tracked files contain something that looks like an email address, an API token or a
# private key, so real transcript data never ends up in the repository.
set -euo pipefail

patterns=(
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|net|org|io|ai|dev|co)'
  'xox[abprs]-[A-Za-z0-9-]{10,}'
  'gh[pousr]_[A-Za-z0-9]{20,}'
  'sk-ant-[A-Za-z0-9_-]{10,}'
  'AKIA[0-9A-Z]{16}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
)
allow='(noreply@|example\.(com|org)|@anthropic-ai/|@hono/|@types/|@vitejs/|@tailwindcss/|@dnd-kit/|@fontsource/)'

status=0
files=$(git ls-files | grep -v -E '^(package-lock\.json|LICENSE)$' || true)
for pattern in "${patterns[@]}"; do
  if [ -n "$files" ] && matches=$(echo "$files" | xargs grep -n -E -e "$pattern" -- 2>/dev/null | grep -v -E "$allow"); then
    echo "Possible secret or personal data:"
    echo "$matches"
    status=1
  fi
done
exit $status
