#!/bin/bash
# Typecheck with the dsh checkout's tsc (same probe convention as build.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/code/deepseek-harness" "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "typecheck: cannot locate the dsh checkout tsc (set DSH_CHECKOUT)" >&2
  exit 1
fi
exec "$TSC" -p tsconfig.json --noEmit
