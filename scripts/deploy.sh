#!/usr/bin/env bash
# Выкладка кабинета на VPS: код едет по ssh, база на сервере не трогается.
#
#   scripts/deploy.sh            — код + перезапуск сервиса
#   scripts/deploy.sh --data     — ещё и выгрузки ФНС с последующим импортом
#
# Хост берётся из ~/.ssh/config (Host vps), переопределяется переменной CHECKER_HOST.
set -euo pipefail

HOST="${CHECKER_HOST:-vps}"
TARGET=/opt/checker
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_DATA=0
[[ "${1:-}" == "--data" ]] && WITH_DATA=1

echo "→ код в $HOST:$TARGET"
tar -czf - -C "$ROOT" \
    --exclude='api/data' \
    --exclude='.git' \
    --exclude='node_modules' \
    api site deploy docs |
  ssh "$HOST" "tar -xzf - -C $TARGET && chown -R checker:checker $TARGET"

if [[ $WITH_DATA -eq 1 ]]; then
  echo "→ выгрузки ФНС"
  tar -czf - -C "$ROOT" api/data/fns_out |
    ssh "$HOST" "tar -xzf - -C $TARGET && chown -R checker:checker $TARGET/api/data"
  echo "→ импорт"
  ssh "$HOST" "sudo -u checker /usr/bin/node $TARGET/api/src/import.mjs"
fi

echo "→ перезапуск"
ssh "$HOST" "systemctl restart checker-api && systemctl --no-pager -l status checker-api | head -5"

echo "готово"
