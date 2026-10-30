#!/usr/bin/env bash
set -euo pipefail
umask 077
if [ "$(id -un)" != www-data ]; then
  echo 'Run release preparation as www-data, not root.' >&2
  exit 1
fi
cd "$(dirname "$0")/.."
if [ ! -f /var/lib/orbit/.env ]; then
  echo 'Create /var/lib/orbit/.env from deploy/production.env.example first.' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
command -v pnpm >/dev/null
ensure_link() {
  local target="$1" link="$2"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then return; fi
  if [ -e "$link" ] || [ -L "$link" ]; then
    echo "Refusing to replace existing $link; expected a symlink to $target" >&2
    exit 1
  fi
  ln -s "$target" "$link"
}
ensure_link /var/lib/orbit/.env .env
ensure_link /var/lib/orbit/runtime .orbit-runtime
pnpm install --frozen-lockfile
pnpm db:setup
pnpm auth:user
PLAYWRIGHT_BROWSERS_PATH=/var/lib/orbit/browsers pnpm exec playwright install chromium
pnpm build
echo 'Release prepared. Activate its symlink and restart Orbit via Supervisor or systemd as administrator.'
