#!/usr/bin/env bash
# School Unity — one-step local start (macOS / Linux)
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org, then run this again."; exit 1
fi
MAJOR=$(node -p "process.versions.node.split('.')[0]"); MINOR=$(node -p "process.versions.node.split('.')[1]")
if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 13 ]; }; then
  echo "School Unity needs Node.js 22.13+ (you have $(node -v)). Update from https://nodejs.org"; exit 1
fi
[ -d node_modules ] || { echo "Installing dependencies (first run only)..."; npm install --no-audit --no-fund; }
npm run --silent seed
PORT=${PORT:-3000}
echo ""
echo "  School Unity is starting at http://localhost:$PORT"
echo "  Sign in: admin@greenfield.edu / admin12345   (press Ctrl+C to stop)"
echo ""
( sleep 2; (command -v open >/dev/null && open "http://localhost:$PORT") || (command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT") || true ) >/dev/null 2>&1 &
PORT=$PORT npm start
