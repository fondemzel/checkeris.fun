#!/usr/bin/env bash
# Развёртывание кабинета на чистом сервере: всё, что раньше делалось руками.
#
#   CHECKER_HOST=vps2 scripts/provision_site.sh              — поставить и настроить
#   CHECKER_HOST=vps2 scripts/provision_site.sh --password X — задать пароль кабинета
#   CHECKER_HOST=vps2 scripts/provision_site.sh --check      — что уже есть на сервере
#
# Скрипт идемпотентный: повторный запуск ничего не ломает, только доводит до нужного
# состояния. Он НЕ выпускает сертификат и НЕ трогает DNS — это делается отдельно
# (scripts/cert_site.sh), когда домен уже смотрит на этот сервер.
#
# После него: scripts/deploy_site.sh --db "…" — код и база.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="${CHECKER_HOST:-vps}"
TARGET=/opt/checker
PORT="${CHECKER_PORT:-8788}"
PASSWORD=""
CHECK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password) PASSWORD="$2"; shift ;;
    --check)    CHECK=1 ;;
    -h|--help)  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "неизвестный аргумент: $1" >&2; exit 1 ;;
  esac
  shift
done

echo "сервер: $HOST"

# ── что уже есть ─────────────────────────────────────────
ssh -T "$HOST" 'bash -s' <<'PROBE'
echo "  ОС:      $(. /etc/os-release; echo "$PRETTY_NAME")"
echo "  ядер:    $(nproc), память: $(free -m | awk '/^Mem:/{print $2}') МБ, диск свободно: $(df -h / | awk 'NR==2{print $4}')"
echo "  node:    $(command -v node >/dev/null && node -v || echo 'нет')"
echo "  nginx:   $(command -v nginx >/dev/null && nginx -v 2>&1 | cut -d/ -f2 || echo 'нет')"
echo "  certbot: $(command -v certbot >/dev/null && certbot --version 2>&1 | cut -d' ' -f2 || echo 'нет')"
echo "  занятые порты 80/443/8788: $(ss -tln 2>/dev/null | grep -cE ':(80|443|8788) ') шт."
PROBE

[[ $CHECK -eq 1 ]] && exit 0

# ── пакеты ───────────────────────────────────────────────
echo "→ пакеты"
ssh -T "$HOST" 'bash -s' <<'INSTALL'
set -e
export DEBIAN_FRONTEND=noninteractive

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "  ставлю Node 24 (нужен встроенный node:sqlite, он с 22.5)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null 2>&1
fi
echo "  node $(node -v)"

command -v nginx >/dev/null || { echo "  ставлю nginx"; apt-get install -y nginx >/dev/null 2>&1; }
# certbot из apt: тянет плагин nginx и systemd-таймер обновления одним пакетом.
# Через snap он тоже ставится, но snapd есть не на каждой машине.
command -v certbot >/dev/null || {
  echo "  ставлю certbot и плагин nginx"
  apt-get install -y certbot python3-certbot-nginx >/dev/null 2>&1
}
command -v openssl >/dev/null || apt-get install -y openssl >/dev/null 2>&1
INSTALL

# ── пользователь и каталоги ──────────────────────────────
echo "→ пользователь и каталоги"
ssh -T "$HOST" "
set -e
id checker >/dev/null 2>&1 || useradd --system --home $TARGET --shell /usr/sbin/nologin checker
mkdir -p $TARGET/api/data/fns_out /var/www/certbot
chown -R checker:checker $TARGET
"

# ── пароль кабинета ──────────────────────────────────────
# Внутри кабинета личные чеки, поэтому без basic auth его наружу не выставляем.
echo "→ доступ"
if [[ -n "$PASSWORD" ]]; then
  ssh -T "$HOST" "
    printf 'checker:%s\n' \"\$(openssl passwd -apr1 '$PASSWORD')\" > /etc/nginx/.htpasswd-checker
    chmod 640 /etc/nginx/.htpasswd-checker && chown root:www-data /etc/nginx/.htpasswd-checker
  "
  echo "  пароль задан: checker / $PASSWORD"
else
  ssh -T "$HOST" "test -f /etc/nginx/.htpasswd-checker" 2>/dev/null &&
    echo "  пароль уже настроен, оставляю как есть" || {
      echo "  ПАРОЛЯ НЕТ. Задайте: scripts/provision_site.sh --password 'ваш-пароль'" >&2
      exit 1
    }
fi

# ── код, конфиги, сервис ─────────────────────────────────
echo "→ код"
tar -czf - --exclude='api/data' --exclude='.git' --exclude='node_modules' \
    api site deploy docs README.md CHANGELOG_SITE.md |
  ssh "$HOST" "tar -xzf - -C $TARGET && chown -R checker:checker $TARGET"

echo "→ сервис и nginx"
ssh -T "$HOST" "
set -e
cp $TARGET/deploy/checker-api.service /etc/systemd/system/
cp $TARGET/deploy/nginx-checkeris.fun.conf /etc/nginx/sites-available/checkeris.fun
ln -sf /etc/nginx/sites-available/checkeris.fun /etc/nginx/sites-enabled/checkeris.fun
systemctl daemon-reload
systemctl enable --now checker-api >/dev/null 2>&1
systemctl restart checker-api
nginx -t >/dev/null 2>&1 && systemctl reload nginx
"

# ── проверка ─────────────────────────────────────────────
sleep 2
echo "→ проверка"
ssh -T "$HOST" "
  printf '  сервис: '; systemctl is-active checker-api
  printf '  API:    '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$PORT/api/meta
  printf '  лендинг: '; curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: checkeris.fun' http://127.0.0.1/
  printf '  кабинет без пароля: '; curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: checkeris.fun' http://127.0.0.1/cabinet/
"

cat <<NEXT

готово. дальше:
  1. база и свежий код:  CHECKER_HOST=$HOST scripts/deploy_site.sh --db "Переезд на новый сервер"
  2. переключить A-записи checkeris.fun и www на новый адрес
  3. сертификат:         CHECKER_HOST=$HOST scripts/cert_site.sh
NEXT
