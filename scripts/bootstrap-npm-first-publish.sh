#!/usr/bin/env bash
set -euo pipefail

# Isolated one-time npm bootstrap publish script:
# Never touches ~/.npmrc, cleans temporary token config immediately on exit.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TMP_NPMRC="$(mktemp -t agmb-npmrc.XXXXXX)"
chmod 600 "$TMP_NPMRC"
cleanup() {
  NPM_CONFIG_USERCONFIG="$TMP_NPMRC" npm logout >/dev/null 2>&1 || true
  rm -f "$TMP_NPMRC"
}
trap cleanup EXIT

export NPM_CONFIG_USERCONFIG="$TMP_NPMRC"
echo "1) Logging in with temporary isolated .npmrc (browser / OTP)..."
npm login --registry=https://registry.npmjs.org

echo "2) Running bridge tests..."
npm test

echo "3) Publishing ag-mobile-bridge@0.1.0 publicly to npm..."
npm publish --access public --registry=https://registry.npmjs.org

echo "Done! Next, bind GitHub Actions Trusted Publisher in npmjs.com -> ag-mobile-bridge -> Settings:"
echo "  Repository owner: oxmumu3"
echo "  Repository name:  ag-mobile-bridge"
echo "  Workflow name:    npm-release.yml"
