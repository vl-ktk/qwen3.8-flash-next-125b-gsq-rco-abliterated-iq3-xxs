# Пункт 16 — подготовлена безопасная первая установка Windows (исходник)

Дата: 20.11.2026. Основная версия до работ: `6bf18bbd99d78c528dd5bee20f698a252d22a469` (GitHub main, подтверждённая сравнением). **[PR #21](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/21) MERGED**, squash исходник `b5ef64ce2c2a6a6cab4864e180e01aef7cb02b6e`. Cloudflare production/ПК/Netcup не изменялись. Откат исходника — вернуть `main` к `6bf18bbd99d78c528dd5bee20f698a252d22a469` отдельным согласованным revert PR; production Worker не выкладывался.

## Реализовано

- Зафиксирован WinSW 2.12.0 x64 (SHA-256 `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`) как обёртка для **настоящих Windows-служб**. Обычный `node.exe` нельзя напрямую подключить к Service Control Manager через `sc create`; WinSW запускает дочерний процесс корректно. Сверка release SHA будет проходить в отдельном packaging CI.
- `Install-KTKMCP.ps1`: проверка Windows 10 22H2+/Windows 11 x64, свободных 600 МиБ, порта 8765, существующих путей и имён служб; SHA256 manifest; отказ от ссылок и непроверенных дополнительных файлов; UAC с перезапуском в повышенном процессе; staging-копирование проверенных файлов.
- Два *отдельных* сервиса `KTKQwenMCP` и `KTKQwenTunnel` под `NT AUTHORITY\LocalService`, режим **Manual/Stopped**, без конфликта с чужой службой `cloudflared`. Исполняемый Node запускается через WinSW; токен Tunnel считывался бы по `--token-file`, а не из аргументов процесса.
- Код в Program Files только для чтения LocalService, ProgramData разделено на `secrets` (чтение LocalService), `state` (чтение) и `logs` (запись); наследование NTFS ACL отключено, доступ задаётся по стабильным SID. Ключ Ed25519 впервые генерируется **на самом устройстве**, приватная часть только в ACL-защищённом файле. Установщик создаёт аварийный lock marker, так что MCP и Tunnel не запускаются автоматически.
- Если первая установка прерывается, сценарий пытается удалить **только собственные** вновь созданные службы/каталоги. Существующую установку перезаписывать отказывается: обновления и ремонт только на этапе 17. Никаких секретов в ZIP нет.
- ZIP `0.16.0` остаётся `ready_for_installation: false`: это тестовый пакет первого этапа, **не Setup.exe и пока не готов для компьютера друга**.

## Дополнение — зашифрованный owner-approved bootstrap (исходник 0.16.1)

**[PR #23](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/23) MERGED**, squash `0e1ff99c02c91a9ef823ae1b3ac7b6f8f044069d`. Исходник до дополнения для отката: `b3b9e046e098d12caa6a9b4820f0c9b8ecace197`; до всего шага 16: `6bf18bbd99d78c528dd5bee20f698a252d22a469`.

- `src/cloudflare/device-bootstrap.mjs` создаёт ephemeral P-256 ECDH, HKDF-SHA256/AES-256-GCM envelope с отдельным контекстом `request_id + device_id`. Worker отдаёт HMAC gateway key и Cloudflare Tunnel token **только зашифрованными для Windows** и лишь после одобрения владельца по прежнему CSRF/password/code/fingerprint. Ответ выдаётся единожды, код и приватные ключи не логируются.
- Новая опция `bootstrap_public_key` не меняет старую привязку: в прежнем режиме Worker **не отдаёт** секреты. Без **обоих** будущих Worker secrets (`QWEN_MCP_GATEWAY_KEY`, `QWEN_TUNNEL_TOKEN`) bootstrapping отвечает `503 bootstrap_not_configured`, без выдуманного успеха.
- Windows `device-enrollment.mjs` генерирует ephemeral P-256 только в RAM, делает HTTPS-запросы к строго фиксированному Worker без редиректов, ждёт одобрение до 10 мин, проверяет AEAD и сохраняет gateway key и Tunnel token только в ACL-папку с эксклюзивным созданием файлов. Секреты не попадают в CLI/архив.
- `Activate-KTKMCP.ps1` на уже подготовленном ПК после одобрения прописывает только публичный `device_id` в MCP-service XML, снимает аварийный lock, запускает две **свои** службы, проверяет реальную HMAC + Ed25519 attestation на `127.0.0.1:8765` и наличие положительных Cloudflare Tunnel HA connections на локальных metrics. Только после них переводит службы в `delayed-auto`. При ошибке возвращает lock + Manual и останавливает службы.
- Изолированные Miniflare/Node тесты проверяют криптографическую совместимость, однократность выдачи, запрет без secret binding, подмену ключей/контекста, невозможность перезаписи credential files, реальную loopback подпись и emergency fail-closed. `Start-KTKMCP.cmd` объединяет staging + owner-approved активацию в **один** запуск с UAC; при сбое сети staged services остаются остановленными и заблокированными. Локально **107/107** тестов, check, Wrangler dry-run PASS.
- [Edge CI #44700104752](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44700104752) **SUCCESS**: 107 тестов, check и dry-run. [Windows candidate CI #44700105268](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44700105268) **SUCCESS**: 3 job — настоящий vendor ZIP с SHA256, PowerShell 5.1/XML parser, распаковка ZIP и `-CheckOnly` на Windows без UAC/SCM/изменений. Артефакт `KTK-Windows-MCP-step16-10`, ID `14612183561`, 61 549 299 байт внешней обёртки, до 27.11.2026 08:08 UTC; внешняя SHA-256 `9785ad230aad9ebfb6bf7c42534efac6dfd3481a87a9f3c04ad5e0e0d9c31b7d` **не является SHA внутреннего ZIP**.

## Не сделано / требуется следующий этап

1. **Нет разрешённой выкладки** нового Worker и нет независимо согласованной загрузки `QWEN_TUNNEL_TOKEN` и `QWEN_MCP_GATEWAY_KEY` в Cloudflare Secrets. В текущем production v11 encrypted bootstrap **не работает**. Для реальной установки требуется отдельное согласованное окно выкладки обоих концов, а не самостоятельное изменение работающей версии.
2. Есть временный одношаговый CMD launcher, но **нет подписанного Setup.exe**, и на Windows не испытаны полномасштабные UAC/SCM/ACL/отказ сети и сквозная ChatGPT OAuth→VPC→Windows диагностика. Запуск из ZIP на ПК друга запрещён до Windows приёмки.
3. Удаление/ремонт/обновление сохранены для пункта 17, приёмка на тестовой Windows — пункт 18. Подписи Authenticode нет. При сбое после одобрения credential files остаются защищёнными, но службы заблокированы; для retry/отзыва требуется пункт 17.

## Проверки

- Linux: **98/98** тестов PASS, `npm run check` PASS, Wrangler dry-run PASS; unit-тесты packaging используют mock vendored exe, SHA256 manifest и статический контракт установки/ACL/сервисов.
- **[GitHub Edge CI #44697700632](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44697700632) SUCCESS** — сборка/check/tests.
- **[GitHub Windows candidate CI #44697700556](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44697700556) SUCCESS** — 3 job: Ubuntu скачал и проверил по SHA256 официальные Node/cloudflared/WinSW, собрал и проверил ZIP; Windows проверил парсер PowerShell 5.1 и оба XML; ещё один Windows job распаковал ZIP и успешно выполнил не повышающий права `Install-KTKMCP.ps1 -CheckOnly` **без установки**.
- Временный GitHub Actions artifact `KTK-Windows-MCP-step16-4`, ID `14612000386`, размер внешней обёртки 61 539 858 байт, expires 27.11.2026 07:49 UTC; digest внешней обёртки `sha256:bdbe0c3f96fc17ec68df5a9754e4ab6d0f42368c3f5a99a2e8e7f8d33de5ea86` **не является SHA внутреннего ZIP**. Это тестовый кандидат, не отдавать другу.
- Исполнение установки на настоящей Windows **не проводилось**. Никакой реальный `/healthz`, UAC или SCM PASS не заявляется.

## Источники

- WinSW v2: https://winsw.github.io/v2/doc/xmlConfigFile/ и https://github.com/winsw/winsw/releases/tag/v2.12.0
- Windows LocalService: https://learn.microsoft.com/en-us/windows/win32/services/localservice-account
- ACL: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls
- Cloudflare `token-file`: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/

**Статус пункта 16: только исходник offline/staging. Галочка остаётся [ ] до защищённого bootstrap, реального запуска и проверки Windows.**
