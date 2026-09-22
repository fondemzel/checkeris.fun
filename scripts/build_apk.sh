#!/usr/bin/env bash
# Сборка приложения для Android — без Gradle, одними инструментами SDK.
#
#   scripts/build_apk.sh           — собрать build/checker.apk
#   scripts/build_apk.sh --install — ещё и поставить на подключённый по USB телефон
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
  --java "$OUT/gen" --auto-add-overlay "$OUT/res.zip"

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

if [[ "${1:-}" == "--install" ]]; then
  ADB="$SDK/platform-tools/adb"
  [[ -x "$ADB" ]] || ADB="$ADB.exe"
  echo "→ установка на телефон"
  "$ADB" install -r "$APK"
fi
