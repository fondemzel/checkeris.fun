#!/usr/bin/env bash
# Выпуск TLS-сертификата для checkeris.fun после переноса домена на VPS.
#
#   scripts/cert_site.sh --check    # где сейчас домен, есть ли сертификат
#   scripts/cert_site.sh            # ждать переезда DNS и выпустить сертификат
#
# Запускать после того, как A-записи checkeris.fun и www переведены на VPS в панели REG.RU.
# Скрипт ждёт, пока домен начнёт резолвиться на сервер (проверяет через 8.8.8.8, минуя
# локальный кэш), затем просит certbot выпустить сертификат и добавить редирект на HTTPS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${CHECKER_HOST:-vps}"
DOMAIN=checkeris.fun
WAIT_MINUTES="${WAIT_MINUTES:-40}"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

IP="$(ssh -G "$HOST" | awk '/^hostname /{print $2}')"
[[ -n "$IP" ]] || { echo "не удалось определить IP хоста $HOST" >&2; exit 1; }

resolve() {
  node -e "
    const dns = require('dns');
    dns.setServers(['8.8.8.8']);
    dns.resolve4(process.argv[1], (err, a) => console.log(err ? '' : a.join(' ')));
  " "$1"
}

echo "сервер $HOST: $IP"
for name in "$DOMAIN" "www.$DOMAIN"; do
  printf '  %-20s → %s\n' "$name" "$(resolve "$name")"
done

if [[ $CHECK_ONLY -eq 1 ]]; then
  ssh -T "$HOST" "certbot certificates 2>/dev/null | grep -E 'Certificate Name|Domains|Expiry' || echo 'сертификатов нет'"
  exit 0
fi

# ── ждём, пока DNS переедет ──────────────────────────────
deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
until [[ "$(resolve "$DOMAIN")" == *"$IP"* ]]; do
  if [[ $(date +%s) -ge $deadline ]]; then
    echo "за $WAIT_MINUTES мин домен так и не переехал на $IP — проверьте A-запись в панели REG.RU" >&2
    exit 1
  fi
  printf '.'
  sleep 30
done
echo
echo "$DOMAIN резолвится на $IP"

WWW_ARG=""
[[ "$(resolve "www.$DOMAIN")" == *"$IP"* ]] && WWW_ARG="-d www.$DOMAIN" || echo "www ещё не переехал — сертификат только на $DOMAIN"

# ── сертификат ───────────────────────────────────────────
# На чистом сервере аккаунта Let's Encrypt нет, и certbot требует почту для
# писем об истечении. Адрес берём из api/.env (CERT_EMAIL) — в репозиторий он
# не попадает. Без адреса регистрируемся молча, но тогда и предупреждений не будет.
CERT_EMAIL="${CERT_EMAIL:-$(grep -s '^CERT_EMAIL=' "$ROOT/api/.env" | cut -d= -f2- | tr -d ' ')}"
if [[ -n "$CERT_EMAIL" ]]; then
  REGISTRATION="--email $CERT_EMAIL"
  echo "почта для уведомлений: $CERT_EMAIL"
else
  REGISTRATION="--register-unsafely-without-email"
  echo "почта не задана — писем об истечении сертификата не будет (CERT_EMAIL в api/.env)"
fi

ssh -T "$HOST" "certbot --nginx -n --agree-tos $REGISTRATION --redirect -d $DOMAIN $WWW_ARG" 2>&1 | tail -12
ssh -T "$HOST" "nginx -t && systemctl reload nginx" 2>&1 | tail -2

# ── проверка ─────────────────────────────────────────────
echo "=== проверка ==="
for p in / /cabinet/; do
  printf '  https://%s%-10s → %s\n' "$DOMAIN" "$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN$p")"
done
printf '  http → %s (ожидается 301)\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://$DOMAIN/")"
echo "продление: snap.certbot.renew.timer, работает автоматически"
