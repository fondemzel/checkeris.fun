@echo off
rem Запись с телефона — в постоянные 60 кадров в секунду для монтажа (рецепт — docs/video/README.md).
rem Запуск: перетащить файл на to_cfr.bat или scripts\to_cfr.bat путь\к\записи.mp4
rem Рядом появится запись_cfr.mp4; исходник не трогается. ffmpeg должен быть в PATH.
ffmpeg -i "%~1" -r 60 -c:v libx264 -crf 18 -g 60 -c:a aac -b:a 192k "%~dpn1_cfr.mp4"
