#!/usr/bin/env bash
# Disposable database only; no deployment credentials or existing volumes.
#
# Gate B4 audit finding L5c: replays the real 0176/0058/0177 migration files
# against a real PostgreSQL server and proves their CHECK constraints
# actually reject the forbidden value (require_write_approval=false,
# apply_mode='direct'). See
# src/__tests__/integration/gateB4WriteApprovalAndApplyMode.postgres.test.ts.
set -euo pipefail
cd "$(dirname "$0")/.."
container="mike-gate-b4-db-test-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$container" \
  -e POSTGRES_PASSWORD=gate-b4-test \
  postgres:16-alpine >/dev/null
ready=false
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 1
done
if [ "$ready" != true ]; then docker logs "$container"; exit 1; fi
export MIKE_TEST_POSTGRES_CONTAINER="$container"
pnpm exec vitest run src/__tests__/integration/gateB4WriteApprovalAndApplyMode.postgres.test.ts --maxWorkers=1
