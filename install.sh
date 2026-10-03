#!/bin/sh
set -eu

REPO="EgoisticCoder/Forma"
VERSION="${FORMA_VERSION:-latest}"
ASSET="forma-cli-bundle.tar.gz"
BASE="https://github.com/${REPO}/releases"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "FORMA needs Node.js 20+ and npm. Install Node from https://nodejs.org/ and rerun." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then echo "FORMA needs Node.js 20 or newer (found $(node --version))." >&2; exit 1; fi

if [ "$VERSION" = "latest" ]; then URL="$BASE/latest/download/$ASSET"; SUM_URL="$BASE/latest/download/SHA256SUMS";
else URL="$BASE/download/$VERSION/$ASSET"; SUM_URL="$BASE/download/$VERSION/SHA256SUMS"; fi
echo "Downloading FORMA ${VERSION}..."
curl -fLsS "$URL" -o "$TMP/$ASSET"
curl -fLsS "$SUM_URL" -o "$TMP/SHA256SUMS"
EXPECTED="$(awk -v f="$ASSET" '$2==f {print $1}' "$TMP/SHA256SUMS")"
if [ -z "$EXPECTED" ]; then echo "Release checksum is missing for $ASSET." >&2; exit 1; fi
if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')";
else ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"; fi
if [ "$EXPECTED" != "$ACTUAL" ]; then echo "Checksum verification failed; the archive was not installed." >&2; exit 1; fi
tar -xzf "$TMP/$ASSET" -C "$TMP"
set -- "$TMP"/forma-cli-bundle/*.tgz
if [ "$#" -lt 2 ]; then echo "Release archive did not contain both Forma packages." >&2; exit 1; fi
npm install --global "$@" opencode-ai
OPENCODE_ROOT="$(npm root --global)/opencode-ai"
if [ -f "$OPENCODE_ROOT/postinstall.mjs" ]; then node "$OPENCODE_ROOT/postinstall.mjs"; fi
if ! command -v opencode >/dev/null 2>&1; then echo "OpenCode's platform CLI did not install. See https://opencode.ai/docs for a manual install." >&2; exit 1; fi
echo "FORMA installed. Run 'forma' to connect your models."
