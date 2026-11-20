# Пункт 16 — подготовлена безопасная первая установка Windows (исходник)

Дата: 20.11.2026. Основная версия до работ: `6bf18bbd99d78c528dd5bee20f698a252d22a469` (GitHub main, подтверждённая сравнением). Cloudflare production/ПК/Netcup не изменялись. Слияние PR и результаты GitHub CI указываются после их фактического получения.

## Реализовано

- Зафиксирован WinSW 2.12.0 x64 (SHA-256 `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`) как обёртка для **настоящих Windows-служб**. Обычный `node.exe` нельзя напрямую подключить к Service Control Manager через `sc create`; WinSW запускает дочерний процесс корректно. Сверка release SHA будет проходить в отдельном packaging CI.
- `Install-KTKMCP.ps1`: проверка Windows 10 22H2+/Windows 11 x64, свободных 600 МиБ, порта 8765, существующих путей и имён служб; SHA256 manifest; отказ от ссылок и непроверенных дополнительных файлов; UAC с перезапуском в повышенном процессе; staging-копирование проверенных файлов.
- Два *отдельных* сервиса `KTKQwenMCP` и `KTKQwenTunnel` под `NT AUTHORITY\LocalService`, режим **Manual/Stopped**, без конфликта с чужой службой `cloudflared`. Исполняемый Node запускается через WinSW; токен Tunnel считывался бы по `--token-file`, а не из аргументов процесса.
- Код в Program Files только для чтения LocalService, ProgramData разделено на `secrets` (чтение LocalService), `state` (чтение) и `logs` (запись); наследование NTFS ACL отключено, доступ задаётся по стабильным SID. Ключ Ed25519 впервые генерируется **на самом устройстве**, приватная часть только в ACL-защищённом файле. Установщик создаёт аварийный lock marker, так что MCP и Tunnel не запускаются автоматически.
- Если первая установка прерывается, сценарий пытается удалить **только собственные** вновь созданные службы/каталоги. Существующую установку перезаписывать отказывается: обновления и ремонт только на этапе 17. Никаких секретов в ZIP нет.
- ZIP `0.16.0` остаётся `ready_for_installation: false`: это тестовый пакет первого этапа, **не Setup.exe и пока не готов для компьютера друга**.

## Не сделано / требуется следующий этап

1. Нет подтверждённого безопасного механизма выдачи одной и той же HMAC gateway key **Cloudflare Worker и Windows origin**, равно как выдачи секретного токена ранее созданного Cloudflare Tunnel. Передача токенов в общий ZIP запрещена; owner-approved, короткоживущий защищённый bootstrap надо разработать и испытать отдельно.
2. Не выполнены автоматическая одноразовая привязка через Worker, переключение служб с Manual на Automatic, удаление аварийного lock marker после утверждённого owner approval, локальный health и end-to-end через Tunnel. Пока запуск запрещён fail-closed.
3. Удаление/ремонт/обновление сохранены для пункта 17; активная установка/ошибочная сеть/недостаток прав/проверка ACL/откат на настоящей Windows — пункт 18. Подписи издателя Authenticode нет.

## Проверки

- Linux: unit-тесты packaging (mock vendored exe), SHA256 manifest, отсутствие секретов и дополнительный статический контракт установки/ACL/сервисов; `npm run check`, `npm test`, Wrangler dry-run.
- GitHub Windows job дополнительно проверяет синтаксис PowerShell 5.1 и XML служб **без установки**; отдельный Ubuntu packaging job скачивает официальный WinSW exe и проверяет SHA256. Итоги указываются по реальному CI, а не заранее.
- Исполнение установки на настоящей Windows **не проводилось**. Никакой реальный `/healthz`, UAC или SCM PASS не заявляется.

## Источники

- WinSW v2: https://winsw.github.io/v2/doc/xmlConfigFile/ и https://github.com/winsw/winsw/releases/tag/v2.12.0
- Windows LocalService: https://learn.microsoft.com/en-us/windows/win32/services/localservice-account
- ACL: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls
- Cloudflare `token-file`: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/

**Статус пункта 16: только исходник offline/staging. Галочка остаётся [ ] до защищённого bootstrap, реального запуска и проверки Windows.**
