# Пункт 17 — обслуживание Windows MCP, candidate 0.17.0

**Статус: исходник подготовлен, реальная Windows/Cloudflare не тестировалась. Пункт 17 нельзя закрывать до приёмки.** Рабочий Cloudflare Worker остаётся прежним (последняя ранее подтверждённая v11); Windows ПК друга, владельца и Netcup не изменялись.

## Возможности исходника

- `scripts/Maintain-KTKMCP.ps1 -Action Update -PackagePath <распакованный_пакет>`: проверка SHA256/manifest/version (новее установленной), UAC, имени и владельца ровно двух KTK-служб, подтверждение в интерактивной консоли, экстренная блокировка и остановка; staging allowlist → `QwenMCP.previous` → атомарная замена каталога. Данные в `%ProgramData%` не переносятся и не перезаписываются, включая device identity и Tunnel/HMAC-секреты.
- Для update/repair предусмотрен `-CheckOnly`: offline-проверка пакета без UAC/служб/записи, её выполняет GitHub Windows CI. Проверка установленной версии и ownership начинается только при реальном запуске.
- `-Action Repair -PackagePath <пакет>`: та же операция **только для той же версии**. При наличии `QwenMCP.previous` сначала нужно осознанно разобрать сохранённую резервную версию; скрипт отказывается её затирать.
- `-Action Rollback`: возврат `QwenMCP.previous`, включая восстановление после разрыва между перемещением старого каталога и установкой нового. Текущий код сохраняется в `QwenMCP.failed-<guid>` для анализа, не стирается автоматически.
- По умолчанию результат обновления/ремонта/отката **Manual, Stopped, emergency-locked**: обслуживание исходника не означает разрешение производственного запуска.
- Явный `-Resume` допустим только для предварительно работающих двух служб и отсутствующего emergency lock. После замены скрипт проверяет HMAC+Ed25519 `SelfTest-KTKMCP.mjs` и минимум одну Cloudflare Tunnel HA connection. Только после этого ставит delayed-auto; при ошибке блокирует, останавливает, возвращает предыдущий каталог. Сквозной ChatGPT OAuth тест всё равно обязателен отдельно.
- `-Action Uninstall`: **две текстовые фразы подтверждения**, проверка reparse points, аварийная блокировка/остановка, удалённая отвязка по свежей подписи приватного Ed25519 ключа устройства с ответом Worker `{state:"revoked"}`, затем удаление **только собственных** двух служб, code и `%ProgramData%` (включая секреты). Если Worker/сеть/пара не подтверждают отзыв, операция прерывается и оставляет установку заблокированной, без ложного сообщения об успешном удалении. Старый `0.16.1` Worker endpoint не поддерживает; для будущего удаления сначала требуется отдельная разрешённая выкладка совместимого Worker.
- `src/cloudflare/device-pairing.mjs` добавляет `POST /device/pair/revoke`: короткое окно timestamp и одноразовый Ed25519 proof, совпадающий с активным устройством; затем атомарно удаляется активная привязка и недоставленный bootstrap envelope. Повторный запрос получает `404`. Owner browser revoke также очищает pending bootstrap.

## Ограничения и запреты

- Нет полноценного подписанного `Setup.exe`, практического UAC/SCM/NTFS/отката после reboot, offline uninstall/owner revocation и Code Signing.
- PowerShell-алгоритм и `-Resume` **не прогонялись на живом Windows**. Автоматический test на Linux проверяет структуру скрипта; GitHub Windows CI должен проверить синтаксис PowerShell 5.1 и offline preflight, но не выполняет опасные операции.
- `Uninstall` нельзя считать завершённым без онлайн-отзыва. В режиме с отсутствующей квитанцией `enrollment.json` скрипт трактует установку как не привязанную; при повреждении квитанции сначала требуется ручная проверка/отзыв через owner UI.
- Не публиковать новый Worker и не provision secrets без отдельного согласия. Не отправлять ZIP другу: manifest `ready_for_installation:false`.
- При резком отключении питания или иных исключениях нужна ручная проверка `QwenMCP.previous`/`QwenMCP.failed-*`, Manual/Stopped и аварийного lock. Не запускать службы «в обход» скрипта.

## Проверки и Git

- До внесения правок GitHub `main`: `d5dbe44d829b2165605296c77ed87d96a435baad` (источник для отката).
- Node 24 + Miniflare: **110/110 PASS**, включая два новых интеграционных теста Ed25519 revocation; `npm run check` PASS; Wrangler `npm run build` dry-run PASS, без выкладки.
- [PR #25](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/25) **MERGED**, squash `fd9d2882e45f8a155d86e634cb90bb3d7395282f`; непосредственно перед merge `main` повторно сравнили с предыдущим SHA и он был идентичен.
- [Edge CI #44701963154](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44701963154) **SUCCESS** (`npm ci`, `check`, `test`, `build` dry-run); [Windows CI #44701963164](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44701963164) **SUCCESS** (PowerShell 5.1 parser, реальная загрузка pinned vendors, SHA256/ZIP, Windows `Install -CheckOnly` и `Maintain -CheckOnly`). Никаких Service Control Manager/UAC mutation/job install тестов нет.
- GitHub artifact: `KTK-Windows-MCP-step17-12`, ID `14613895764`, SHA256 контейнера Actions artifact `0dc315633084d163a69ab43a6e59b091d6afb614d9ee28a4e0d7c5c0c1e35234`, истекает **27.11.2026 08:22 UTC**. ZIP всё ещё содержит `ready_for_installation:false`.
- Важные новые файлы: `scripts/Maintain-KTKMCP.ps1`, `scripts/Revoke-KTKMCP.mjs`, `src/windows/device-revocation.mjs`, тесты и кандидат пакетировки `0.17.0`.

## Далее

Шаг 18: на отдельной тестовой Windows выполнить сценарии staging, UAC, повреждение пакета, отказ сети/отзыва, обновление со здоровым/сбойным Tunnel, ремонт, rollback, uninstall, reboot, ACL и отсутствие побочных действий по чужим службам. До этого галочки пунктов 15–18 остаются пустыми; живой ПК друга не затрагивать.
