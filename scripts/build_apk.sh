#!/usr/bin/env bash
# Сборка приложения для Android — без Gradle, одними инструментами SDK.
#
#   scripts/build_apk.sh                   — собрать build/checker.apk с текущей версией
#   scripts/build_apk.sh --install         — ещё и поставить на подключённый по USB телефон
#   scripts/build_apk.sh --release "что нового"          — поднять версию (0.1.0 → 0.1.1) и
#   scripts/build_apk.sh --release --minor "что нового"  — положить сборку в releases/android
#
# Версия приложения — своя, не как у сайта: сайт обновляется выкладкой и переустановки не
# требует, а новый apk нужен, только когда менялся родной код. Номер лежит в
# client/android/version.json; code растёт на единицу — по нему Android отличает обновление.
#
# Почему не Gradle: приложение — один экран без библиотек, а Gradle тянет сотни мегабайт
# кеша и свой демон. Здесь всё в четыре шага: ресурсы (aapt2) → классы (javac) → байткод
# для Android (d8) → подпись (apksigner).
#
# Что нужно (у вас уже есть, ставится вместе с Android Studio):
#   Android SDK    — платформа android-34+, build-tools 34+; путь берётся из ANDROID_HOME,
#                    ANDROID_SDK_ROOT или из обычного места установки
#   Java 17+       — берётся из Android Studio (jbr) или из PATH
#
# Ключ подписи создаётся сам при первой сборке и лежит в ~/.checker/android.jks — в репозиторий
# он не едет. Его нельзя терять: без него телефон не примет обновление приложения.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC=client/android
OUT=build/android
APK=build/checker.apk
VERSION_FILE=$SRC/version.json
RELEASES=releases/android

PY=$(command -v python3 || command -v python)

LEVEL=patch
RELEASE=0
INSTALL=0
NOTES=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) RELEASE=1 ;;
    --install) INSTALL=1 ;;
    --major)   LEVEL=major ;;
    --minor)   LEVEL=minor ;;
    --patch)   LEVEL=patch ;;
    -*)        echo "неизвестный флаг: $1" >&2; exit 1 ;;
    *)         NOTES="${NOTES:+$NOTES }$1" ;;
  esac
  shift
done
[[ $RELEASE -eq 0 || -n "$NOTES" ]] || { echo "к релизу нужно описание: что изменилось в приложении" >&2; exit 1; }

# Версия: при релизе поднимаем и сохраняем, иначе берём как есть
if [[ $RELEASE -eq 1 ]]; then
  "$PY" - "$VERSION_FILE" "$LEVEL" <<'PYCODE'
import json, sys
path, level = sys.argv[1], sys.argv[2]
v = json.load(open(path, encoding='utf-8'))
major, minor, patch = (int(x) for x in v['name'].split('.'))
if level == 'major': major, minor, patch = major + 1, 0, 0
elif level == 'minor': minor, patch = minor + 1, 0
else: patch += 1
v['name'], v['code'] = f'{major}.{minor}.{patch}', v['code'] + 1
json.dump(v, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(path, 'a', encoding='utf-8').write(chr(10))
PYCODE
fi
VERSION_NAME=$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1], encoding='utf-8'))['name'])" "$VERSION_FILE")
VERSION_CODE=$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1], encoding='utf-8'))['code'])" "$VERSION_FILE")

# ── где SDK и Java ───────────────────────────────────────
win_path() { command -v cygpath >/dev/null && cygpath -u "$1" || echo "$1"; }

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[[ -d "${SDK:-}" ]] || SDK="$(win_path "${LOCALAPPDATA:-$HOME}")/Android/Sdk"
[[ -d "$SDK" ]] || { echo "не найден Android SDK: задайте ANDROID_HOME" >&2; exit 1; }

# Самая свежая из установленных: и платформа, и инструменты сборки
latest() { ls "$1" | sort -V | grep -v rc | tail -1; }
PLATFORM="$SDK/platforms/$(latest "$SDK/platforms")"
TOOLS="$SDK/build-tools/$(latest "$SDK/build-tools")"
ANDROID_JAR="$PLATFORM/android.jar"
[[ -f "$ANDROID_JAR" ]] || { echo "нет $ANDROID_JAR" >&2; exit 1; }

JAVA_HOME_APP="${JAVA_HOME:-}"
[[ -x "${JAVA_HOME_APP}/bin/javac" ]] || JAVA_HOME_APP="$(win_path "${ProgramFiles:-/c/Program Files}")/Android/Android Studio/jbr"
JAVAC="$JAVA_HOME_APP/bin/javac"
KEYTOOL="$JAVA_HOME_APP/bin/keytool"
command -v "$JAVAC" >/dev/null || JAVAC=javac
command -v "$KEYTOOL" >/dev/null || KEYTOOL=keytool

# На Windows инструменты — .exe и .bat
ext() { [[ -x "$TOOLS/$1" ]] && echo "$TOOLS/$1" || { [[ -f "$TOOLS/$1.exe" ]] && echo "$TOOLS/$1.exe" || echo "$TOOLS/$1.bat"; }; }
AAPT2="$(ext aapt2)"
D8="$(ext d8)"
ZIPALIGN="$(ext zipalign)"
APKSIGNER="$(ext apksigner)"

echo "SDK:      $SDK"
echo "версия    $VERSION_NAME (code $VERSION_CODE)"
echo "платформа $(basename "$PLATFORM"), инструменты $(basename "$TOOLS")"

# ── ключ подписи ─────────────────────────────────────────
KEYSTORE="${CHECKER_KEYSTORE:-$HOME/.checker/android.jks}"
STOREPASS="${CHECKER_KEYPASS:-checker-local}"
if [[ ! -f "$KEYSTORE" ]]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  echo "→ ключ подписи $KEYSTORE (создаётся один раз, не теряйте)"
  "$KEYTOOL" -genkeypair -v -keystore "$KEYSTORE" -alias checker -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$STOREPASS" -keypass "$STOREPASS" \
    -dname "CN=Checker, OU=checkeris.fun, O=Checker, C=RU" >/dev/null
fi

# ── сборка ───────────────────────────────────────────────
rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/classes" "$(dirname "$APK")"

echo "→ ресурсы"
"$AAPT2" compile --dir "$SRC/res" -o "$OUT/res.zip"
"$AAPT2" link -o "$OUT/base.apk" -I "$ANDROID_JAR" \
  --manifest "$SRC/AndroidManifest.xml" \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME"   --java "$OUT/gen" --auto-add-overlay "$OUT/res.zip"

# Версия — в код: приложение показывает её сайту через мост
sed -i.bak "s/VERSION = \".*\"/VERSION = \"$VERSION_NAME\"/" "$SRC/java/ru/checkeris/app/BuildInfo.java"
rm -f "$SRC/java/ru/checkeris/app/BuildInfo.java.bak"

echo "→ классы"
mkdir -p "$OUT/gen"
find "$SRC/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
"$JAVAC" -source 17 -target 17 -nowarn -encoding UTF-8 \
  -classpath "$ANDROID_JAR" -d "$OUT/classes" "@$OUT/sources.txt" 2>&1 | grep -v 'bootstrap class path' || true

echo "→ байткод Android"
"$D8" --release --lib "$ANDROID_JAR" --output "$OUT" $(find "$OUT/classes" -name '*.class')

echo "→ сборка и подпись"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT" && "$(command -v python3 || command -v python)" -c "
import zipfile
z = zipfile.ZipFile('unsigned.apk', 'a', zipfile.ZIP_DEFLATED)
z.write('classes.dex', 'classes.dex')
z.close()
")
"$ZIPALIGN" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass "pass:$STOREPASS" --key-pass "pass:$STOREPASS" \
  --out "$APK" "$OUT/aligned.apk"
"$APKSIGNER" verify "$APK" >/dev/null

SIZE=$(( $(stat -c%s "$APK" 2>/dev/null || stat -f%z "$APK") / 1024 ))
echo "готово: $APK (${SIZE} КБ)"

# ── релиз: сборка в releases/android и сведения о последней версии ──
if [[ $RELEASE -eq 1 ]]; then
  mkdir -p "$RELEASES"
  RELEASE_APK="$RELEASES/checker-$VERSION_NAME.apk"
  cp "$APK" "$RELEASE_APK"
  "$PY" - "$RELEASES/latest.json" "$VERSION_NAME" "$VERSION_CODE" "$(basename "$RELEASE_APK")" "$NOTES" "$RELEASE_APK" <<'PYCODE'
import hashlib, json, sys
from datetime import date
out, name, code, file, notes, apk = sys.argv[1:7]
blob = open(apk, 'rb').read()
data = {
    'name': name,
    'code': int(code),
    'file': file,
    'size': len(blob),
    'sha256': hashlib.sha256(blob).hexdigest(),
    'date': date.today().isoformat(),
    'notes': notes,
}
json.dump(data, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(out, 'a', encoding='utf-8').write(chr(10))
PYCODE
  echo "релиз:  $RELEASE_APK"
fi

if [[ $INSTALL -eq 1 ]]; then
  ADB="$SDK/platform-tools/adb"
  [[ -x "$ADB" ]] || ADB="$ADB.exe"
  echo "→ установка на телефон"
  "$ADB" install -r "$APK"
fi
