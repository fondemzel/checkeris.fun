# Ролики: исходники и готовые файлы

Папка с файлами роликов. В git попадает только этот README: видео, звук и проекты After Effects большие и лежат на Яндекс Диске вместе с проектом. Сценарии, тексты и рецепт съёмки — в [docs/video](../docs/video/README.md).

```
video/
  01-expenses/        ← ролик 1 «Экран „Расход“» (docs/video/01-expenses.*)
    raw/              записи со съёмки (scripts/film.mjs --rec video/01-expenses/raw/…mp4)
    voice/            озвучка: 01.wav, 02.wav… — по фразам из 01-expenses.voice.md
    ae/               проект After Effects
    final/            готовый ролик
```

Новый ролик — папка `NN-тема/` с теми же подпапками, имя — как у его сценария в docs/video.
