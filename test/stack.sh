#!/bin/sh
# test/stack.sh up|down|logs   the test stack by hand
cd "$(dirname "$0")/.."
files="-f docker-compose.yml -f test/docker-compose.yml"
case "$1" in
  up) docker compose --env-file test/test.env $files -p activation-test up -d ;;
  down) docker compose --env-file test/test.env $files -p activation-test down -v ;;
  logs) docker compose --env-file test/test.env $files -p activation-test logs --tail "${TAIL:-40}" ;;
  *) docker compose --env-file test/test.env $files -p activation-test "$@" ;;
esac
