# Деплой на VPS

Сервер: `95.163.220.218` (REG.RU, Ubuntu 24.04), в `~/.ssh/config` заведён как `Host vps`.
На нём уже живут другие проекты за общим nginx — конфиг кабинета их не трогает.

| Что | Где |
| --- | --- |
| Код | `/opt/checker` (владелец — системный пользователь `checker`) |
| База и выгрузки | `/opt/checker/api/data` — единственный каталог, куда сервису разрешена запись |
| Сервис | `checker-api.service`, слушает `127.0.0.1:8788` |
| nginx | `/etc/nginx/sites-available/checkeris.fun` → `sites-enabled` |
| Пароль кабинета | `/etc/nginx/.htpasswd-checker` (basic auth на `/cabinet` и `/api/`) |

Порт 8788 выбран потому, что 8001 занят `kpp-api`.

## Первичная установка

```bash
# Node 22.5+ нужен из-за встроенного node:sqlite
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

useradd --system --home /opt/checker --shell /usr/sbin/nologin checker
mkdir -p /opt/checker/api/data/fns_out
chown -R checker:checker /opt/checker

# пароль кабинета
printf 'checker:%s\n' "$(openssl passwd -apr1 'ПАРОЛЬ')" > /etc/nginx/.htpasswd-checker
chmod 640 /etc/nginx/.htpasswd-checker
chown root:www-data /etc/nginx/.htpasswd-checker

# конфиги
cp /opt/checker/deploy/checker-api.service /etc/systemd/system/
cp /opt/checker/deploy/nginx-checkeris.fun.conf /etc/nginx/sites-available/checkeris.fun
ln -s /etc/nginx/sites-available/checkeris.fun /etc/nginx/sites-enabled/checkeris.fun
systemctl daemon-reload && systemctl enable --now checker-api
nginx -t && systemctl reload nginx
```

## Обновление

Одной командой с рабочей машины:

```bash
scripts/deploy_site.sh "Что изменилось"          # версия, changelog, коммит, тег, push, выкладка
scripts/deploy_site.sh --minor "Раздел категорий"
scripts/deploy_site.sh --data "Выгрузка за январь"   # ещё и выгрузки ФНС + импорт
scripts/deploy_site.sh --no-version                  # выложить как есть, без нового номера
scripts/deploy_site.sh --dry-run "Проверка"          # показать план, ничего не делать
```

Каждая выкладка поднимает версию в `api/package.json` (по умолчанию patch) и добавляет строку
в `CHANGELOG_SITE.md`; тег `vX.Y.Z` уходит на GitHub вместе с коммитом.
`scripts/deploy_site.sh --help` печатает правила, что писать в описание.

Скрипт не трогает `api/data` — база на сервере переживает выкладку. Выгрузки ФНС едут
только по флагу `--data`, потому что в репозитории их нет: это личные чеки.

В конце скрипт сам сверяет версию: дёргает `http://127.0.0.1:8788/api/meta` на сервере
(в обход nginx, поэтому пароль кабинета не нужен) и падает, если код не доехал.
Версия видна и в меню кабинета, под периодом данных.

## Домен и TLS

Решено переносить домен на VPS целиком: лендинг и кабинет живут за одним nginx,
работает исходная схема `checkeris.fun/cabinet`.

**1. A-записи в панели REG.RU** (зоной управляет хостинг, NS = `ns1/ns2.hosting.reg.ru`):

| Запись | Было | Стало |
| --- | --- | --- |
| `@` (checkeris.fun) | 31.31.196.120 | **95.163.220.218** |
| `www` | 31.31.196.120 | **95.163.220.218** |

MX (`mx1/mx2.hosting.reg.ru`), TXT и NS не трогаем — почта остаётся на хостинге REG.RU.
Меняются только A-записи.

**2. Сертификат** — сразу после смены записей:

```bash
scripts/cert_site.sh --check   # где сейчас домен и какие сертификаты есть
scripts/cert_site.sh           # ждёт переезда DNS и выпускает сертификат
```

Скрипт опрашивает 8.8.8.8 (минуя локальный кэш), дожидается, пока домен начнёт
резолвиться на VPS, запускает `certbot --nginx --redirect` и проверяет результат.
Certbot сам добавит TLS-блок и редирект с 80 на 443 в `/etc/nginx/sites-available/checkeris.fun`,
поэтому боевой конфиг станет длиннее шаблона в `deploy/` — так и задумано, шаблон
остаётся HTTP-версией для первичной установки.

Аккаунт Let's Encrypt на сервере уже зарегистрирован (для `andersen.moscow`), почта
не спрашивается. Продление — snap-таймером `snap.certbot.renew.timer`, он активен.

Пока DNS переезжает, сайт какое-то время может открываться со старого хостинга —
это нормально, там лежит тот же лендинг. HSTS на старом хостинге не выставлен,
так что окно без HTTPS браузеры переживут спокойно. Файлы на шаред-хостинге лучше
не удалять до конца переезда.

## Доступ

Вход проверяет приложение, а не nginx: basic-аутентификация снята, вёрстка открыта,
данные закрыты токеном (подробно — в [cabinet.md](cabinet.md), раздел «Доступ»).
Основной способ входа — Telegram, пароль остался у аккаунтов, заведённых до него.

## Бот входа через Telegram

С основного сервера (vps2, REG.RU) до `api.telegram.org` не достучаться — хостинг режет
соединения. Поэтому бот `@checker_costs_bot` живёт на зарубежном сервере **vps3**
(37.46.19.120, Франкфурт) и ходит оттуда в Telegram и в Чекер. Основной сервер в Telegram
не обращается никогда: бот приходит к нему запросами, подписанными общим секретом.

На vps3 работают и чужие службы (например, `kpp-bot`) — бот отгорожен от них:

| Что | Где |
| --- | --- |
| Node.js | `/opt/node` → `/opt/node-v24.21.0-linux-x64`, официальная сборка; системного node нет |
| код | `/opt/checker-bot/relay.mjs`, владелец root, без зависимостей |
| настройки | `/opt/checker-bot/.env`, `600 root`: `TG_BOT_TOKEN`, `TG_RELAY_SECRET`, `CHECKER_URL` |
| служба | `checker-bot.service` ([deploy/checker-bot.service](../deploy/checker-bot.service)), пользователь `checkerbot` |

`TG_RELAY_SECRET` один и тот же в `.env` бота и в `api/.env` Чекера — без совпадения
бот получает 401 на каждый запрос. Поменять секрет — поменять в обоих местах и перезапустить обе службы.

```bash
scripts/deploy_bot.sh            # выложить bot/relay.mjs и перезапустить
scripts/deploy_bot.sh --setup    # ещё и описание и меню бота в Telegram
ssh vps3 'journalctl -u checker-bot -f'
```

Первичная установка на новом сервере: Node в `/opt` (архив с nodejs.org, сверка по
`SHASUMS256.txt`), `useradd --system --shell /usr/sbin/nologin checkerbot`, папка
`/opt/checker-bot` с `relay.mjs` и `.env`, юнит в `/etc/systemd/system/`,
`systemctl enable --now checker-bot`, затем `relay.mjs --setup` с загруженным `.env`.
