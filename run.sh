#!/usr/bin/env bash
# Stockyard: pull fresh data and serve the map locally.
#   ./run.sh          serve, refreshing data if it is older than 10 minutes
#   ./run.sh --fresh  force a fresh pull first
#   ./run.sh --serve  skip the pull, serve whatever is in data/
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8787}"
DATA="data/page.json"

stale() {
  [ ! -f "$DATA" ] && return 0
  local age=$(( $(date +%s) - $(stat -f %m "$DATA" 2>/dev/null || stat -c %Y "$DATA") ))
  [ "$age" -gt 600 ]
}

case "${1:-}" in
  --serve) ;;
  --fresh) python3 tools/longbow.py; python3 tools/pull.py ;;
  *) if stale; then echo "data is stale, pulling..."; python3 tools/longbow.py; python3 tools/pull.py; else echo "data is fresh"; fi ;;
esac
mkdir -p public/data && cp -f "$DATA" public/data/page.json
case x in
esac

echo
echo "  Stockyard -> http://localhost:$PORT"
echo "  ctrl-c to stop"
echo
(sleep 1 && open "http://localhost:$PORT" 2>/dev/null) &
exec python3 -c '
import functools, http.server, sys
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map,
                          **{".html": "text/html; charset=utf-8",
                             ".json": "application/json; charset=utf-8"})
    def log_message(self, *a): pass
import os, functools
H=functools.partial(H, directory="public")
http.server.test(HandlerClass=H, port=int(sys.argv[1]), bind="127.0.0.1")
' "$PORT"
