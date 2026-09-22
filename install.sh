#!/usr/bin/env bash
# Install jev-model-router into ~/.claude.
#   TYPESAFE_API_KEY=apikey_... ./install.sh
# The key is NEVER stored in this package; it is written to settings.json here.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.claude/skills/jev-model-router"
SETTINGS="$HOME/.claude/settings.json"

command -v claude >/dev/null || { echo "claude CLI not found"; exit 1; }
VER=$(claude --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
printf '2.1.259\n%s\n' "$VER" | sort -V -C || { echo "needs Claude Code >= 2.1.259 (found $VER)"; exit 1; }

: "${TYPESAFE_API_KEY:?set TYPESAFE_API_KEY=apikey_... before running}"

mkdir -p "$DEST"
rsync -a --delete --exclude install.sh --exclude .git "$SRC"/ "$DEST"/ 2>/dev/null \
  || { rm -rf "$DEST"; mkdir -p "$DEST"; (cd "$SRC" && tar cf - --exclude install.sh --exclude .git .) | (cd "$DEST" && tar xf -); }

[ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak-$(date +%Y%m%d-%H%M%S)"

TYPESAFE_API_KEY="$TYPESAFE_API_KEY" SETTINGS="$SETTINGS" python3 - <<'PY'
import json, os, collections
p = os.environ['SETTINGS']
s = json.load(open(p), object_pairs_hook=collections.OrderedDict) if os.path.exists(p) else collections.OrderedDict()
s.setdefault('env', collections.OrderedDict())['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS'] = '1'
s.setdefault('pluginConfigs', collections.OrderedDict())['jev-model-router@skills-dir'] = {
    'options': {
        'typesafeApiKey': os.environ['TYPESAFE_API_KEY'],
        'provider': 'typesafe',
        'timeoutMs': 2500,
        # jev reads only the latest message, so a short follow-up can score
        # 'fast' in a huge session. Haiku (200k window) stays safe because the
        # router refuses any non-[1m] model once live context passes
        # smallModelMaxTokens, instead of forcing a compaction it can't fit.
        'fastModel': 'haiku',
        'balancedModel': 'claude-sonnet-5[1m]',
        'deepModel': 'claude-opus-5-5[1m]',
        'smallModelMaxTokens': 150000,
        'routeMainModel': True,
        'routeSubagentModel': False,
    }
}
json.dump(s, open(p, 'w'), indent=2); open(p, 'a').write('\n')
print('settings.json updated')
PY

claude plugin validate "$DEST"
echo
echo "Installed. Restart claude, then look for:"
echo "  [jev-model-router] ready on typesafe (https://api.typesafe.ai/v1/systemone)"
