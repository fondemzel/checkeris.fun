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

С рабочей машины:

```bash
scripts/deploy.sh            # код + перезапуск сервиса
scripts/deploy.sh --data     # ещё и новые выгрузки ФНС + импорт
```

Скрипт кладёт код по ssh и не трогает `api/data` — база на сервере переживает выкладку.
Выгрузки едут отдельным флагом, потому что в репозитории их нет: это личные чеки.

Проверка после выкладки:

```bash
ssh vps 'systemctl status checker-api --no-pager | head -5'
ssh vps 'curl -s -u checker:ПАРОЛЬ -o /dev/null -w "%{http_code}\n" http://127.0.0.1/api/meta -H "Host: checkeris.fun"'
```

## Домен и TLS

Сейчас `checkeris.fun` указывает на шаред-хостинг `31.31.196.120`, где лежит только лендинг.
Кабинету нужен Node, поэтому дальше два пути:

1. **Перенести домен целиком на VPS** — A-запись `checkeris.fun` и `www` на `95.163.220.218`.
   Тогда работает исходная схема `checkeris.fun/cabinet`, лендинг отдаётся тем же nginx
   из `/opt/checker/site`.
2. **Оставить лендинг на хостинге**, а под кабинет завести поддомен — A-запись
   `cabinet.checkeris.fun` на `95.163.220.218` и `server_name cabinet.checkeris.fun`
   в конфиге nginx.

После того как DNS отрезолвится на VPS:

```bash
certbot --nginx -d checkeris.fun -d www.checkeris.fun   # или -d cabinet.checkeris.fun
```

Certbot сам допишет TLS-блок и редирект с 80 на 443. До этого момента конфиг работает
по HTTP и отвечает в том числе на обращение по IP — чтобы кабинет можно было проверить,
не трогая DNS.

## Доступ

Кабинет закрыт basic-аутентификацией на уровне nginx: внутри личные чеки с адресами
и фискальными реквизитами. Лендинг (`/`) открыт всем.

Сменить пароль:

```bash
ssh vps "printf 'checker:%s\n' \"\$(openssl passwd -apr1 'НОВЫЙ')\" > /etc/nginx/.htpasswd-checker && systemctl reload nginx"
```

Basic auth — временная мера на период, пока база одна и общая. Полноценную авторизацию
имеет смысл делать вместе с личными кабинетами пользователей.
