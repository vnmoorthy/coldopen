#!/usr/bin/env bash
# Cold Open: set optional Worker secrets. Values are read from your terminal (or your
# Stripe CLI config) and piped straight into `wrangler secret put`. Nothing is printed or saved.
set -euo pipefail
cd "$(dirname "$0")/.."

WORKER_URL="https://coldopen.vnarasingamoorthy.workers.dev"

put() { printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null 2>&1 && echo "  ✓ $1 set" || echo "  ✗ $1 failed"; }
ask() {
  local name=$1 prompt=$2 val=""
  read -r -s -p "$prompt (Enter to skip): " val; echo
  if [ -n "$val" ]; then put "$name" "$val"; else echo "  – $name skipped"; fi
}

echo "Cold Open secrets setup"
echo "1) The brain of every agent: Claude (sk-ant-...) or OpenAI (sk-...)"
ask ANTHROPIC_API_KEY "   Anthropic API key"
ask OPENAI_API_KEY "   OpenAI API key"

echo "2) Stripe test mode: verified payments and per-business checkout links"
if command -v stripe >/dev/null 2>&1 && [ -f "$HOME/.config/stripe/config.toml" ]; then
  read -r -p "   Use the test-mode key from your Stripe CLI [default] profile? [Y/n] " yn
  if [[ "${yn:-Y}" =~ ^[Yy]$ ]]; then
    key=$(python3 -c "import tomllib,os;print(tomllib.load(open(os.path.expanduser('~/.config/stripe/config.toml'),'rb'))['default']['test_mode_api_key'])" 2>/dev/null || true)
    if [[ "$key" == sk_test_* || "$key" == rk_test_* ]]; then put STRIPE_SECRET_KEY "$key"; else echo "  – no test key found in Stripe CLI config"; fi
    read -r -p "   Register the Stripe webhook ($WORKER_URL/api/stripe/webhook) and store its signing secret? [Y/n] " yn2
    if [[ "${yn2:-Y}" =~ ^[Yy]$ ]]; then
      whsec=$(stripe webhook_endpoints create --url "$WORKER_URL/api/stripe/webhook" -d "enabled_events[]=checkout.session.completed" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('secret',''))" 2>/dev/null || true)
      if [[ "$whsec" == whsec_* ]]; then put STRIPE_WEBHOOK_SECRET "$whsec"; else echo "  – webhook registration failed"; fi
    fi
  fi
else
  ask STRIPE_SECRET_KEY "   Stripe TEST secret key (sk_test_...)"
fi

echo "3) Slack: mirror the agent channel into a real Slack channel"
ask SLACK_WEBHOOK_URL "   Slack incoming webhook URL"

echo "4) Higgsfield: cinematic launch ads"
ask HIGGSFIELD_API_KEY "   Higgsfield API key"
ask HIGGSFIELD_API_SECRET "   Higgsfield API secret (if your key has one)"

echo "5) Brainbase: independent second-opinion review by a Brainbase managed agent"
ask BRAINBASE_API_KEY "   Brainbase API key (app.brainbaselabs.com)"

echo "6) Taste Labs: Brand API extraction and scoring"
ask TASTE_API_KEY "   Taste Labs API key"

echo "Done. Integrations light up in Mission Control on the next page load: $WORKER_URL"
