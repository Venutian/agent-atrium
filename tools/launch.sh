#!/usr/bin/env bash
# Ubuntu/Linux: build changed sources, start only this checkout, and open the office.
set -euo pipefail
project_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd -- "$project_root"
mkdir -p data
command -v node >/dev/null || { echo 'Install Node.js 22.13+ (24 LTS recommended).' >&2; exit 1; }
command -v npm >/dev/null || { echo 'npm is required.' >&2; exit 1; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22 || major===22&&minor<13)process.exit(1)' || { echo 'Node.js 22.13+ is required.' >&2; exit 1; }
port="${PORT:-5274}"
[[ "$port" =~ ^[0-9]{1,5}$ ]] || { echo 'PORT must be a number.' >&2; exit 1; }
port=$((10#$port)); (( port >= 1 && port <= 65535 )) || exit 1
headless=false
stop=false
for option in "$@"; do
  case "$option" in --headless) headless=true;; --stop) stop=true;; *) echo "Unknown option: $option" >&2; exit 1;; esac
done
exec 9>data/launcher.lock
flock -n 9 || exit 0
owned_pid() {
  [[ -f data/server.pid ]] || return 1
  local server_pid
  server_pid="$(cat data/server.pid)"
  [[ "$server_pid" =~ ^[0-9]+$ ]] || return 1
  [[ -r "/proc/$server_pid/cmdline" ]] || return 1
  tr '\0' '\n' <"/proc/$server_pid/cmdline" | grep -Fxq -- "$project_root/server/serve.mjs" || return 1
  printf '%s' "$server_pid"
}
if $stop; then
  if server_pid="$(owned_pid)"; then kill -TERM "$server_pid"; fi
  exit 0
fi
[[ -d node_modules ]] || { echo 'Run npm ci in this project first.' >&2; exit 1; }
if [[ ! -f dist/index.html ]] || [[ -n "$(find src public index.html package.json package-lock.json vite.config.js -type f -newer dist/index.html -print -quit)" ]]; then
  npm run build >data/build.log 2>&1 || { echo 'Build failed. See data/build.log.' >&2; exit 1; }
fi
if server_pid="$(owned_pid)"; then
  if [[ ! -f data/server.stamp ]] || [[ -n "$(find server package.json -type f -newer data/server.stamp -print -quit)" ]]; then
    kill -TERM "$server_pid"
    for attempt in {1..30}; do kill -0 "$server_pid" 2>/dev/null || break; sleep 0.1; done
  fi
fi
healthy() {
  node --input-type=module - "$port" "$project_root" <<'JS' >/dev/null 2>&1
try {
  const response = await fetch(`http://127.0.0.1:${process.argv[2]}/api/health`, { signal: AbortSignal.timeout(800) });
  const health = await response.json();
  process.exit(response.ok && health.service === 'agent-atrium' && health.workspace === process.argv[3] ? 0 : 1);
} catch { process.exit(1); }
JS
}
if ! healthy; then
  PORT="$port" nohup node "$project_root/server/serve.mjs" >>data/server.log 2>>data/server-error.log 9>&- &
  printf '%s\n' "$!" >data/server.pid
  touch data/server.stamp
  for attempt in {1..40}; do healthy && break; sleep 0.25; done
fi
healthy || { echo 'Server did not start. Check the port and data/server-error.log.' >&2; exit 1; }
if ! $headless; then
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v xdg-open >/dev/null; then
    xdg-open "http://localhost:$port" >/dev/null 2>&1 &
  else
    printf 'Agent Atrium is running at http://localhost:%s\n' "$port"
  fi
fi
