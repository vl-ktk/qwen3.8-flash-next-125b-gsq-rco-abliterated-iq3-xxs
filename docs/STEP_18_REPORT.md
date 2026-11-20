# Пункт 18 — единый тестовый установщик для Windows 10/11

**Статус: исходник и тестовый EXE `0.18.0` собраны; автоматический CI Windows и Edge PASS; Cloudflare Worker v12 выложен и прошёл публичный read-only HTTPS smoke; запуск на ПК владельца ещё не проводился.** Windows и Netcup не менялись.

Владелец подтвердил: **испытание на основной Windows 10 Pro 22H2, без виртуальной машины и без ручного ввода отдельных PowerShell-команд.** Установщик должен быть одним EXE с UAC, внутренними проверками и читаемым отчётом. Никаких изменений рабочего ПК до передачи проверенного EXE и подтверждения владельца.

## Candidate 0.18.0

- `config/KTK-Setup.iss`: Inno Setup, один `KTK-Qwen-MCP-Setup-0.18.0-TEST-UNSIGNED.exe`, содержащий только manifest-verified payload. Двойной клик открывает установщик; UAC обязателен. Это **не подписанный production setup**; Windows SmartScreen может показать предупреждение.
- `scripts/Run-KTKAcceptance.ps1 -Live`: автоматически проверяет SHA256/manifest, версию Windows, диск, порты, отсутствие конфликтующих KTK-служб/директорий, затем вызывает существующую защищённую установку/привязку, проверяет обе службы `LocalService` и emergency marker, сохраняет текстовый отчёт `KTK-MCP-Test-*.txt` на рабочем столе. Пользователю не требуется открывать PowerShell или вводить команды. **Один раз потребуется подтверждение Windows UAC и пары на странице Worker** (выдача секрета без подтверждения запрещена).
- `-Offline` предназначен только для автоматических тестов GitHub: реальная установка двух служб Manual/Stopped, проверка новых identity/lock и отсутствия credentials, затем удаление только своего свежего тестового экземпляра. Никаких Cloudflare запросов.
- `windows-package.yml`: Node/Linux suite; PowerShell 5 parser; Windows `-CheckOnly`; отдельный Windows-hosted job реальных SCM/ACL/cleanup; Inno Setup compile в единый EXE и SHA256 **и запуск именно этого EXE в CI с внутренним `/OFFLINE`-режимом**, чтобы проверить фактическую установку/удаление. ZIP/EXE upload GitHub Actions.

## Проверенное в CI 20.11.2026

- [PR #27](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/27) MERGED; source commit `8c2eef4a68d68bb90e553fcfad815f562826bbf1`. До шага 18 исходник был `0a448c7ae587296988339e4a1e619cd442642f81` — это source rollback target.
- [Edge CI #44706904820](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44706904820) **SUCCESS**: npm checks, 111/111 tests, Wrangler build dry-run. Локально на Node проверены 111/111, `npm run check`, Wrangler dry-run.
- [Windows CI #44706904865](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44706904865) **SUCCESS**, все 5 jobs: реальный PowerShell 5.1 syntax parser, supply-chain hashes / package, non-elevated preflight, установка обеих LocalService-служб + ACL + очистка на disposable Windows runner, сборка Inno Setup и **запуск собранного EXE** с `/OFFLINE` (внутри шага сборки; exit 0, test services after cleanup absent). Онлайн-привязка намеренно не выполнялась.
- Из этого прогона сохранён GitHub Actions artifact `KTK-MCP-Setup-step18-14`, ID `14615786351`, размер 44 244 741 байт (включает EXE и SHA256-текст), до **27.11.2026 09:00 UTC**. Artifact digest GitHub: `sha256:15f874c87fd29d3ce7ecf695b57c80563359b7246ba23e9b98a2f28aecde8e5e`. Это hash внешнего artifact ZIP, **не SHA256 самого EXE**; внутренний `.sha256` находится рядом с EXE. Артефакт тестовый и неподписанный; не означает готовности к установке у владельца.

## Опубликовано в Cloudflare 20.11.2026 с разрешения владельца

- До правки: Worker `qwen125b-mcp` **v11**, version `8e719c62-5316-434d-b092-fd0f3cdc81d5`, deployment `5667dd47-6d10-47d8-a9dc-ab8d262047f1`, 100%. Это **Cloudflare rollback target**.
- После read-only сверки настроек и полного `npm run check`, 111/111 tests, Wrangler dry-run собран новый Worker из GitHub `main` `f742472b9762a877b0a70436073e1da9ab37edcb`. Minified bundle `SHA256 6d551a09d11bdf8915cd420b70bae7174d7c3ee98ef84742d985793a41463dbc`.
- **v12**, version `ef98df54-3b31-43a6-bed3-f87554ae249a`, deployment `cc78916c-8fa7-4e00-9fc9-3de70281d7d9`, API-проверено **100%**. Сохранены прежние OAuth owner-password secret, generation `1`, прежние SQLite Durable Object (тот же namespace), VPC Service; добавлены secret_text `QWEN_MCP_GATEWAY_KEY` (криптографически случайные 32 байта) и `QWEN_TUNNEL_TOKEN` (получен из существующего `ktk-qwen125b-friend-pc` Cloudflare Tunnel). Содержимое секретов в Git, файлы, чаты и отчёты **не выводилось**.
- [Live HTTPS CI #44710520897](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44710520897) **SUCCESS**: настоящий `workers.dev` отвечает `GET /__edge_status` **200** с `protected`, OAuth protected-resource **200**, OAuth authorization-server **200**, `/mcp` без Bearer **401**. Это read-only живые публичные запросы, а не Miniflare; владелец не вводил пароль. Внутренний Cloudflare API зафиксировал v12 100%. GitHub CI workflow `live-edge-smoke.yml` в [PR #29](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/29) **MERGED**, commit `fa61c876114d04782529c3da10c201068ccc7db6`; Edge CI #44710520760 SUCCESS.
- Прямой HTTP-fetch из Cloudflare-коннектора ChatGPT вернул `403 Forbidden: requests ... are not allowed` **до** попадания в Worker; поэтому публичный smoke был перенесён на GitHub runner. Этот внутренний запрет egress не свидетельствует об ошибке Worker.

## Чего **пока нет**

- Cloudflare Worker и обе secret bindings теперь опубликованы, но **реальная одноразовая привязка устройства, Tunnel HA, локальный Windows HMAC/Ed25519 self-test, интерактивный OAuth и сквозной ChatGPT MCP ещё не проверены**. Tunnel при последнем Cloudflare API-чтении `inactive`, 0 подключений — это ожидаемо до установки на ПК. Не называть пакет полностью готовым к эксплуатации до приёмки.
- Тест GitHub runner не равен реальному Windows UAC (у GitHub hosted Windows UAC отключён), а тест из ChatGPT не автоматизируется без живого соединения. Эти две проверки пройдут непосредственно на ПК владельца после подготовленного пакета.
- Code signing сертификата нет, официальный цифровой подписи издателя нет. Это должно быть явно видно в имени test artifact; не рекомендовать отключать защиту Windows.
- Установщик не трогает существующую инсталляцию и не заменяет чужой cloudflared. На ошибке оставляет аварийно заблокированную уже созданную установку для диагностики; в отчёте об этом сообщается.

## Git и следующий шаг

- Source PR #27 влит после контрольного сравнения `main` с исходной базой — расхождений не было. Откат исходника: commit `0a448c7ae587296988339e4a1e619cd442642f81`. Cloudflare rollback: повторный 100% deployment v11 version `8e719c62-5316-434d-b092-fd0f3cdc81d5` (старый deployment `5667dd47-6d10-47d8-a9dc-ab8d262047f1`); не использовать принудительный `force` без отдельной проверки возможной потери новых secrets и текущей версии.
- Далее — согласовать реальный запуск одного EXE на основной Windows 10 Pro, подтверждение UAC и одноразовой привязки, затем полный ChatGPT→Worker→Tunnel→Windows MCP, сбои сети, rollback и безопасное удаление. До того шаг 18 остаётся `[ ]`.
