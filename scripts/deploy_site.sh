#!/usr/bin/env bash
# Выкладка сайта и кабинета: версия → CHANGELOG_SITE.md → коммит с тегом →
# push на GitHub → код на VPS → перезапуск сервиса → проверка версии.
#
#   scripts/deploy_site.sh "Карточка товара в правой панели"   # 0.5.0 → 0.5.1
#   scripts/deploy_site.sh --minor "Раздел категорий"          # 0.5.1 → 0.6.0
#   scripts/deploy_site.sh --major "Личные кабинеты"           # 0.6.0 → 1.0.0
#   scripts/deploy_site.sh --data "Выгрузка за январь"         # ещё и выгрузки ФНС + импорт
#   scripts/deploy_site.sh --db "Словарь категорий"            # ещё и снимок локальной базы
#   scripts/deploy_site.sh --no-version                        # выложить как есть, без релиза
#   scripts/deploy_site.sh --no-deploy "Только в репозиторий"
#   scripts/deploy_site.sh --dry-run "Проверка"                # показать план, ничего не делать
#
# КАЖДАЯ ВЫКЛАДКА ПОДНИМАЕТ ВЕРСИЮ. По умолчанию patch (0.5.0 → 0.5.1);
# --minor для нового раздела или заметной функции, --major для несовместимых изменений.
# Выложить без нового номера можно только флагом --no-version.
#
# Описание идёт строкой в CHANGELOG_SITE.md, поэтому пишется для человека,
# который через полгода вспоминает, что поменялось. Правила — в hint() ниже.
#
# Все незакоммиченные изменения попадают в релизный коммит — это и есть «засейвить».
# Хост берётся из ~/.ssh/config (Host vps), переопределяется переменной CHECKER_HOST.
set -euo pipefail

hint() {
  cat >&2 <<'TEXT'

Что писать в описание (оно же строка changelog):
  • что изменилось для того, кто пользуется кабинетом, а не какие файлы правились
  • одна строка, с заглавной буквы, без точки в конце
  • достаточно конкретно, чтобы понять смысл без git log

  хорошо:  "Карточка товара в правой панели вместо раскрытия строки"
           "Экспорт CSV учитывает фильтры списка"
           "Боковое меню разделов, светлая тема"
  плохо:   "правки", "фиксы после ревью", "update", "деплой"

Версия поднимается на каждой выкладке:
  без флага   patch  0.5.0 → 0.5.1   правки, мелкие улучшения
  --minor            0.5.1 → 0.6.0   новый раздел или заметная функция
  --major            0.6.0 → 1.0.0   несовместимые изменения
TEXT
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="${CHECKER_HOST:-vps}"
TARGET=/opt/checker
LEVEL=patch
VERSIONED=1
DEPLOY=1
PUSH=1
DATA=0
DB=0
DRY=0
MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --major)      LEVEL=major ;;
    --minor)      LEVEL=minor ;;
    --patch)      LEVEL=patch ;;
    --data)       DATA=1 ;;
    --db)         DB=1 ;;
    --no-version) VERSIONED=0 ;;
    --no-deploy)  DEPLOY=0 ;;
    --no-push)    PUSH=0 ;;
    --dry-run)    DRY=1 ;;
    -h|--help)    sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; hint; exit 0 ;;
    -*)           echo "неизвестный флаг: $1" >&2; exit 1 ;;
    *)            MESSAGE="${MESSAGE:+$MESSAGE }$1" ;;
  esac
  shift
done

CURRENT="$(node -p "require('./api/package.json').version")"
NEXT="$CURRENT"

if [[ $VERSIONED -eq 1 ]]; then
  if [[ -z "$MESSAGE" ]]; then
    echo "нужно описание: scripts/deploy_site.sh \"что изменилось\"" >&2
    hint
    exit 1
  fi

  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  [[ "$BRANCH" == "main" ]] || { echo "релиз делается из main, сейчас: $BRANCH" >&2; exit 1; }

  NEXT="$(node -e "
    const [ma, mi, pa] = process.argv[1].split('.').map(Number);
    const level = process.argv[2];
    console.log(level === 'major' ? [ma + 1, 0, 0].join('.')
              : level === 'minor' ? [ma, mi + 1, 0].join('.')
              : [ma, mi, pa + 1].join('.'));
  " "$CURRENT" "$LEVEL")"

  echo "релиз $CURRENT → $NEXT ($LEVEL) — версия поднимается на каждой выкладке"
  echo "  в CHANGELOG_SITE.md уйдёт строкой: $MESSAGE"
  git status --short | sed 's/^/  /' || true
else
  echo "выкладка текущего кода, версия $CURRENT"
fi

if [[ $DRY -eq 1 ]]; then
  echo "(dry-run: ничего не изменено)"
  exit 0
fi

# ── версия, changelog, коммит, тег, push ─────────────────
if [[ $VERSIONED -eq 1 ]]; then
  node -e "
    const fs = require('fs');
    const pkgPath = 'api/package.json';
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = process.argv[1];
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

    const entry = '## ' + process.argv[1] + ' — ' + process.argv[2] + '\n\n- ' + process.argv[3] + '\n';
    const log = fs.readFileSync('CHANGELOG_SITE.md', 'utf8');
    const at = log.indexOf('## ');
    fs.writeFileSync('CHANGELOG_SITE.md', log.slice(0, at) + entry + '\n' + log.slice(at));
  " "$NEXT" "$(date +%F)" "$MESSAGE"

  git add -A
  git commit -q -m "$NEXT: $MESSAGE"
  git tag -a "v$NEXT" -m "$MESSAGE"
  echo "коммит $(git rev-parse --short HEAD), тег v$NEXT"

  if [[ $PUSH -eq 1 ]]; then
    git push -q origin main --follow-tags
    echo "запушено в origin/main"
  fi
fi

[[ $DEPLOY -eq 1 ]] || { echo "готово (без выкладки)"; exit 0; }

# ── код на сервер ────────────────────────────────────────
echo "→ код в $HOST:$TARGET"
tar -czf - --exclude='api/data' --exclude='.git' --exclude='node_modules' \
    api site deploy docs README.md CHANGELOG_SITE.md |
  ssh "$HOST" "tar -xzf - -C $TARGET && chown -R checker:checker $TARGET"

# ── выгрузки ФНС: в git их нет, едут только по требованию ─
if [[ $DATA -eq 1 ]]; then
  echo "→ выгрузки ФНС"
  tar -czf - api/data/fns_out |
    ssh "$HOST" "tar -xzf - -C $TARGET && chown -R checker:checker $TARGET/api/data"
  echo "→ импорт"
  ssh "$HOST" "sudo -u checker /usr/bin/node $TARGET/api/src/import.mjs 2>&1 | grep -v Experimental | grep -v trace-warnings"
fi

# ── снимок базы: словарь категорий и разметка живут только в ней ──────────
# ВНИМАНИЕ: перезаписывает базу на сервере целиком. Пока источник данных один
# (ваши выгрузки), это безопасно; когда чеки начнут добавляться на сервере,
# заливать словарь нужно будет отдельно, а не всей базой.
if [[ $DB -eq 1 ]]; then
  echo "→ снимок базы"
  SNAPSHOT=api/data/.deploy-snapshot.db
  rm -f "$SNAPSHOT"
  # VACUUM INTO даёт согласованный снимок даже при активной записи
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('api/data/checker.db', { readOnly: true });
    db.exec(\"VACUUM INTO '$SNAPSHOT'\");
    const n = db.prepare('SELECT COUNT(*) c FROM dictionary').get().c;
    console.error('  словарь: ' + n + ' названий');
  " 2>&1 | grep -v Experimental | grep -v trace-warnings

  echo "→ база на сервер ($(du -h "$SNAPSHOT" | cut -f1))"
  gzip -c "$SNAPSHOT" | ssh "$HOST" "
    gunzip > $TARGET/api/data/checker.db.new &&
    systemctl stop checker-api &&
    mv $TARGET/api/data/checker.db.new $TARGET/api/data/checker.db &&
    rm -f $TARGET/api/data/checker.db-wal $TARGET/api/data/checker.db-shm &&
    chown checker:checker $TARGET/api/data/checker.db"
  rm -f "$SNAPSHOT"
fi

echo "→ перезапуск"
ssh "$HOST" "systemctl restart checker-api"

# ── проверка: сервис отвечает в обход nginx, пароль не нужен ─
sleep 1
LIVE="$(ssh "$HOST" "curl -s http://127.0.0.1:8788/api/meta" |
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.version+' '+j.stats.receipts)}catch{console.log('? ?')}})")"
LIVE_VERSION="${LIVE% *}"
LIVE_RECEIPTS="${LIVE#* }"

if [[ "$LIVE_VERSION" != "$NEXT" ]]; then
  echo "ВНИМАНИЕ: на сервере v$LIVE_VERSION, ожидалась v$NEXT" >&2
  ssh "$HOST" "systemctl --no-pager -l status checker-api | head -12" >&2
  exit 1
fi

echo "на сервере v$LIVE_VERSION, чеков в базе: $LIVE_RECEIPTS"
echo "готово: http://95.163.220.218/cabinet/"
