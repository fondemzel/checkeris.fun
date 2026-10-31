# Сертификат платёжного API

`russian-trusted-root.pem` — публичный Russian Trusted Root CA Минцифры,
тот же сертификат, который уже используется Android-клиентом
(`client/android/res/raw/mincifry_root.pem`). SHA-256:

`D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`

Т-Банк использует эту цепочку для `securepay.tinkoff.ru`.
Node получает дополнительный доверенный корень через `NODE_EXTRA_CA_CERTS`
в сервисе checker-api. Стандартные корни, проверка имени хоста и цепочки сохраняются.

Официальная инструкция: https://developer.tbank.ru/eacq/intro/certificates/
Сертификаты: https://www.gosuslugi.ru/crt
