#!/usr/bin/env sh
# {{SECRET_tvfsq523}} API — point Claude Code at an {{SECRET_tvfsq523}} gateway.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/larryluozhang/{{SECRET_tvfsq523}}-api/che/cli/setup-claude.sh | sh -s -- --url http://192.168.2.146:3001
#   (optionally)  ... | sh -s -- --url <origin> --key <unified-key>
#
# Writes ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY into Claude Code's settings.json
# (env block), preserving every other key. Model routing is decided on the
# gateway (Keys → Anthropic family map), so no per-host model names are needed.
set -eu

ORIGIN=""
KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) ORIGIN="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$ORIGIN" ]; then
  echo "setup-claude: --url <origin> is required" >&2
  exit 1
fi
# Strip any trailing slash and any /v1 suffix — Claude appends /v1/messages.
ORIGIN=$(printf '%s' "$ORIGIN" | sed 's:/*$::; s:/v1$::')
KEY="${KEY:-${ANTHROPIC_API_KEY:-}}"
if [ -z "$KEY" ]; then
  echo "setup-claude: pass --key <unified-key> or export ANTHROPIC_API_KEY first" >&2
  exit 1
fi

SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
mkdir -p "$(dirname "$SETTINGS")"
if [ ! -f "$SETTINGS" ]; then printf '{}' > "$SETTINGS"; fi
cp -p "$SETTINGS" "$SETTINGS.bak-{{SECRET_tvfsq523}}-$(date +%Y%m%d-%H%M%S)"

# Merge the env block without disturbing other settings (node is everywhere the
# gateway is; fall back to a clear error if absent).
node - "$SETTINGS" "$ORIGIN" "$KEY" <<'NODE'
const fs = require('fs');
const [file, origin, key] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
j.env = { ...(j.env || {}), ANTHROPIC_BASE_URL: origin, ANTHROPIC_API_KEY: key };
fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
console.log('Wrote ' + file + ': ANTHROPIC_BASE_URL=' + origin);
NODE

echo "Done. Restart Claude Code (or open a new task) to use the gateway."
