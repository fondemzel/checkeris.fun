#!/usr/bin/env bash
# Обновление бота входа (@checker_costs_bot) на зарубежном сервере.
#
#   scripts/deploy_bot.sh            — выложить bot/relay.mjs и перезапустить
#   scripts/deploy_bot.sh --setup    — ещё и обновить описание и меню бота в Telegram
#
# Хост — ssh-псевдоним из ~/.ssh/config, по умолчанию vps3; другой — BOT_HOST=...
# Первичная установка (Node, пользователь, .env, служба) описана в docs/deploy.md.
set -euo pipefail

HOST="${BOT_HOST:-vps3}"
DIR=/opt/checker-bot
cd "$(dirname "$0")/.."

node --check bot/relay.mjs
echo "→ bot/relay.mjs в $HOST:$DIR"
scp -q bot/relay.mjs "$HOST:$DIR/relay.mjs"
scp -q deploy/checker-bot.service "$HOST:/etc/systemd/system/checker-bot.service"

SETUP=""
[[ "${1:-}" == "--setup" ]] && SETUP="cd $DIR && set -a && . ./.env && set +a && /opt/node/bin/node relay.mjs --setup;"

ssh "$HOST" "chown root:root $DIR/relay.mjs && chmod 644 $DIR/relay.mjs && $SETUP
  systemctl daemon-reload && systemctl restart checker-bot && sleep 2 &&
  systemctl is-active checker-bot && journalctl -u checker-bot --no-pager -n 3 | tail -2"
echo "готово"
