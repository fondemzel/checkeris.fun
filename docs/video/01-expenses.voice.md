# Ролик 1 — голос (Fish Audio Drama 3)

Текст для синтеза: одна фраза — один файл (`01.wav`, `02.wav`…) в [video/01-expenses/voice](../../video/README.md); их раскладывают по таймлайну в монтаже. Исходный текст и раскадровка — [01-expenses.md](01-expenses.md).

Генерация — моделью Drama 3 локально (ComfyUI). Голос SpeechKit не подошёл: звучал вяло.

## Настройки

- **Голос** выбирается референсом (`reference_id` или образец в ComfyUI), а не текстом: женский, **русскоязычный** — с англоязычным будет акцент. Один и тот же голос на все фразы.
- **Дубли:** у Drama 3 они заметно различаются — на каждую фразу 3–4 и выбрать лучший.
- **Формат:** WAV, 48 кГц — без потерь для монтажа.

## Разметка Drama 3

- `[…]` в начале — режиссёрское указание: манера, свободным текстом. Пишем по-английски — модель лучше понимает указания на английском, а читает русский текст. **Одно и то же указание во всех фразах** — иначе голос будет разным от фразы к фразе.
- `[short pause]` — короткая пауза там, где на экране идёт действие; `[pause]` — длиннее.
- `<emphasis>…</emphasis>` — выделить слова голосом; `<slow>…</slow>` — замедлить. Только на главное: по одному на фразу, не больше.
- Ударений, как `+` в SpeechKit, нет. Проблемные слова — проверить на слух: «маркетплейсов» (маркетпл**е**йсов), «лимит» (лим**и**т), «Чекер» (Ч**е**кер). Ошиблась — попробовать заглавную ударную гласную: «маркетплЕйсов».
- Если модель прочитала указание вслух — убрать его и оставить только паузы.

## Указание (одно на все фразы)

```
[bright, upbeat female narrator of a product tutorial; warm and engaged, a light smile in the voice, lively but natural pace, clear diction — energetic without sounding like an ad]
```

Ниже оно уже вставлено в каждую фразу — копировать блок целиком.

## Фразы

**01** — 0–6 с, кольцо заливается
```
[bright, upbeat female narrator of a product tutorial; warm and engaged, a light smile in the voice, lively but natural pace, clear diction — energetic without sounding like an ad] Экран расхода показывает все траты за выбранный период. [short pause] Кольцо делит их на группы: питание, жильё, транспорт и другие.
```

**02** — 6–16 с, нажатие на группу
```
[bright, upbeat female narrator of a product tutorial; warm and engaged, a light smile in the voice, lively but natural pace, clear diction — energetic without sounding like an ad] Нажатие на группу открывает её кольцо: [short pause] категории группы и их доли.
```

**03** — 16–26 с, список покупок категории
```
[bright, upbeat female narrator of a product tutorial; warm and engaged, a light smile in the voice, lively but natural pace, clear diction — energetic without sounding like an ad] Нажатие на категорию открывает список покупок. [short pause] Покупки попадают сюда из чеков, банковских приложений и маркетплейсов, [short pause] их можно добавить и вручную. [short pause] Каждая строка — <emphasis>отдельная покупка</emphasis> с ценой и датой.
```

**04** — 26–36 с, свайп месяцев
```
[bright, upbeat female narrator of a product tutorial; warm and engaged, a light smile in the voice, lively but natural pace, clear diction — energetic without sounding like an ad] Свайп влево или вправо переключает период. [short pause] Суммы и доли пересчитываются <emphasis>сразу</emphasis>.
```

**05** — 36–45 с, долгое нажатие на «Расход»
```
[bright, upbeat female narrator of a product tutorial; warm and engaged, a light smile in the voice, lively but natural pace, clear diction — energetic without sounding like an ad] <emphasis>Долгое нажатие</emphasis> на кнопку расхода открывает выбор периода: [short pause] сегодня, неделя, месяц или год.
```

**06** — 45–58 с, режим списка
```
[bright, upbeat female narrator of a product tutorial; warm and engaged, a light smile in the voice, lively but natural pace, clear diction — energetic without sounding like an ad] Кольцо можно переключить на список. [short pause] Здесь все покупки собраны в разделы по категориям. [short pause] Раздел раскрывается нажатием.
```

**07** — 58–66 с, сортировка
```
[bright, upbeat female narrator of a product tutorial; warm and engaged, a light smile in the voice, lively but natural pace, clear diction — energetic without sounding like an ad] Сортировка: [short pause] по названию, по сумме или по дате — [short pause] тогда разделы становятся днями.
```

**08** — 66–74 с, фильтр
```
[bright, upbeat female narrator of a product tutorial; warm and engaged, a light smile in the voice, lively but natural pace, clear diction — energetic without sounding like an ad] Фильтр оставляет покупки из одного источника: [short pause] чеки, банк, маркетплейсы или ручные записи, [short pause] или только нужные группы.
```

**09** — 74–88 с, поиск и карточка
```
[bright, upbeat female narrator of a product tutorial; warm and engaged, a light smile in the voice, lively but natural pace, clear diction — energetic without sounding like an ad] Поиск находит покупки по названию за выбранный период. [pause] Карточка покупки содержит детальную информацию: дату, продавца, категорию и <emphasis>комментарий</emphasis>.
```

**10** — 88–100 с, лимит
```
[bright, upbeat female narrator of a product tutorial; warm and engaged, a light smile in the voice, lively but natural pace, clear diction — energetic without sounding like an ad] Если для группы задан лимит, [short pause] под кольцом видно, сколько потрачено, сколько осталось и <emphasis>сколько можно тратить в день</emphasis> до конца месяца.
```

**11** — 100–107 с, заставка
```
[bright, upbeat female narrator of a product tutorial; warm and engaged, a light smile in the voice, lively but natural pace, clear diction — energetic without sounding like an ad] Чекер. [pause] Учёт расходов по чекам и операциям банков.
```

## Отличия от текста раскадровки

- «Экран „Расход“» → «Экран расхода», «долгое нажатие на „Расход“» → «на кнопку расхода»: название в кавычках голос произносит как обычное слово, и на слух непонятно, что это кнопка.
- Фильтр: «— чеки, банк… —» → двоеточие и запятые: тире в середине фразы синтез читает без нужной паузы.
