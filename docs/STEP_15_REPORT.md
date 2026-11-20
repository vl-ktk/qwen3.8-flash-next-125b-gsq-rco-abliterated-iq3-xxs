# Пункт 15 — проверяемый Windows payload (до установщика)

Дата: 20.11.2026. Исходник: `feature/step15-windows-payload` на базе `main` `d2410eeb12a078d55e574ec2a40cb345ee7f8d99`.

## Сделано в исходнике

- `config/windows-package.lock.json`: зафиксированы целевые **Windows x64**, `Node.js 24.22.3`, `cloudflared 2026.11.1`, только официальные HTTPS URL, точные SHA-256, версии и лицензии.
- `src/packaging/vendor-fetch.mjs`: скачивание **только в локальный каталог сборки**. До перемещения готового файла сверяется SHA-256; подмена, старый/пустой файл, symlink, лишний размер — отказ.
- `src/packaging/windows-package.mjs`: явный список runtime-модулей без тестов, `.env`, токенов, ключей и модели; фиксированные метаданные архива, `MANIFEST.json` с SHA-256 и размером каждого файла; `SHA256SUMS.txt`; отдельный `zip.sha256`.
- `scripts/Verify-KTKPackage.ps1`: **только проверка** SHA-256 файлов распакованного пакета Windows, без повышения прав, загрузки или установки.
- `.github/workflows/windows-package.yml`: отдельная сборка при PR и ручном запуске, скачивает реальные бинарники по закреплённым URL, сверяет хеши, прогоняет упаковочные тесты и загружает ZIP + checksum как GitHub Actions artifact (срок хранения 7 суток). Самостоятельно ничего не устанавливает и не публикует в Cloudflare.

## Публичные версии и контрольные суммы

| Компонент | Файл | SHA-256 официального релиза |
|---|---|---|
| Node.js 24.22.3 | `win-x64/node.exe` | `86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6` |
| Cloudflare cloudflared 2026.11.1 | `cloudflared-windows-amd64.exe` | `341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35` |

Источники: [Node.js 24.22.3 signed SHASUMS](https://nodejs.org/en/blog/release/v24.22.3/) и [Cloudflare 2026.11.1 release checksums](https://github.com/cloudflare/cloudflared/releases/tag/2026.11.1). Важно: это сверка содержимого с публичными SHA; **подпись издателя Windows (Authenticode) и подпись самого архива отдельно не проверены**.

## Состав ZIP

`bin/node.exe`, `bin/cloudflared.exe`, необходимые `runtime/*.mjs`, `config/windows-mcp.defaults.json` (только шаблон), `licenses/*`, `MANIFEST.json`, `SHA256SUMS.txt`, `Verify-KTKPackage.ps1`, `README.txt`.

В архиве **нет** Ed25519 private key, HMAC gateway secret, Tunnel token, OAuth token, паролей, модели SC117 или Strata. Source commit записывается в манифест и README; ZIP и checksum привязаны к конкретной CI-сборке.

## Проверки и граница пункта 15

- Linux: `npm test` **95/95 PASS**; `npm run check` PASS; `npm run build` Wrangler dry-run PASS. Unit tests пакета проверили воспроизводимый байт-в-байт ZIP на фиктивных бинарниках, отсутствие секретов/тестов, хеши всех файлов, ошибочный vendor SHA, отсутствие файла, symlink и отказ при перезаписи.
- Реальные Windows `node.exe`/`cloudflared.exe`: только автоматическая сборка GitHub сможет скачать и проверить их; локальный Linux-тест подменяет их фиктивными файлами **только внутри теста**. Результат workflow указать после GitHub CI.
- **Не готово для конечного пользователя:** автоматический `Setup.exe`, UAC, NTFS ACL, сервис LocalService, защита хранилища, Cloudflare gateway key, Tunnel bootstrap, одноразовая pairing, откат. Это пункты 16–18. Содержимое архива явно помечено `ready_for_installation: false`; запускать на ПК нельзя.
- До Windows-приёмки пункт 15 в дорожной карте остаётся [ ]. Рабочий Cloudflare v11, Windows владельца/друга и Netcup не трогались. Предыдущая версия исходников для отката: `d2410eeb12a078d55e574ec2a40cb345ee7f8d99`.

GitHub PR/CI/артефакт: дополнить после запуска проверки.
