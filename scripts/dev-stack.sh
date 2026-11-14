#!/usr/bin/env bash
# Local Supabase stack for development and e2e tests.
# Usage: scripts/dev-stack.sh start|stop|reset|env
set -euo pipefail
cd "$(dirname "$0")/.."

# Cloud/CI sandboxes may block public.ecr.aws; Docker Hub mirrors the same images.
export SUPABASE_INTERNAL_IMAGE_REGISTRY="${SUPABASE_INTERNAL_IMAGE_REGISTRY:-docker.io}"
EXCLUDE="studio,logflare,vector,imgproxy,edge-runtime,mailpit,supavisor,postgres-meta"

ensure_docker() {
  if ! docker info >/dev/null 2>&1; then
    if command -v dockerd >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
      echo "Starting dockerd..." >&2
      nohup dockerd >/tmp/dockerd.log 2>&1 &
      for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
    fi
    docker info >/dev/null 2>&1 || { echo "Docker is not running." >&2; exit 1; }
  fi
}

write_env() {
  # Writes apps/web/.env.local with local stack credentials (keeps unrelated keys).
  local status api anon service
  status="$(pnpm exec supabase status -o env 2>/dev/null)"
  api="$(echo "$status" | sed -n 's/^API_URL="\(.*\)"$/\1/p')"
  anon="$(echo "$status" | sed -n 's/^ANON_KEY="\(.*\)"$/\1/p')"
  service="$(echo "$status" | sed -n 's/^SERVICE_ROLE_KEY="\(.*\)"$/\1/p')"
  local f=apps/web/.env.local
  touch "$f"
  grep -v -E '^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY)=' "$f" > "$f.tmp" || true
  {
    cat "$f.tmp"
    echo "NEXT_PUBLIC_SUPABASE_URL=$api"
    echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=$anon"
    echo "SUPABASE_SERVICE_ROLE_KEY=$service"
  } > "$f"
  rm -f "$f.tmp"
  echo "Wrote $f" >&2
}

case "${1:-start}" in
  start) ensure_docker; pnpm exec supabase start -x "$EXCLUDE"; write_env ;;
  stop)  pnpm exec supabase stop ;;
  reset) ensure_docker; pnpm exec supabase db reset; write_env ;;
  env)   write_env ;;
  *) echo "usage: $0 start|stop|reset|env" >&2; exit 2 ;;
esac
