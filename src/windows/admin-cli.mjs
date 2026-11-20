import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createLocalServiceController, createLocalRebootGate, checkLocalHealth, getAdminStatus, WINDOWS_SERVICE_NAME } from "./administration.mjs";
import { runPowerShellQuery } from "./windows-tools.mjs";
import { createEmergencyLock } from "./emergency-lock.mjs";

const COMMANDS = new Set(["status", "health", "start", "stop", "restart", "configure_recovery", "reboot", "lock", "unlock", "help"]);
const CONTROL = new Set(["start", "stop", "restart", "configure_recovery"]);
const HELP = `KTK Qwen MCP — локальная консоль Windows\n\nКоманды:\n  status             состояние MCP и службы (только чтение)\n  health             проверка http://127.0.0.1:8765/healthz\n  lock               аварийно блокировать доступ через MCP\n  unlock             разблокировать MCP после проверки причины\n  start              запустить службу с подтверждением\n  stop               остановить службу с подтверждением\n  restart            перезапустить службу с подтверждением\n  configure_recovery настроить перезапуск службы после сбоев\n  reboot             запросить перезагрузку Windows с двойным подтверждением и локальным отменяемым отсчётом 120 с\n  help               показать эту справку\n\nСлужба появится только после этапа установки. Управление и перезагрузка не доступны через удалённый MCP.\n`;

async function promptLocal(question, options = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question, options)).trim(); }
  finally { rl.close(); }
}

// All privileged entry points are intentionally process-local and interactive.
// Callers can inject mocks for Linux tests; the real entry point never listens
// on a TCP socket and never accepts commands from MCP/HTTP.
export async function runAdminCli({
  args = process.argv.slice(2),
  platform = process.platform,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask = promptLocal,
  write = line => process.stdout.write(line),
  readService = serviceName => runPowerShellQuery("service_status", { name: serviceName }),
  healthCheck = checkLocalHealth,
  makeController = createLocalServiceController,
  makeRebootGate = createLocalRebootGate,
  makeEmergencyLock = createEmergencyLock,
  emergencyPath = process.env.QWEN_MCP_EMERGENCY_LOCK_PATH,
  paired = Boolean(process.env.QWEN_DEVICE_IDENTITY_PATH && process.env.QWEN_DEVICE_ID),
} = {}) {
  if (!Array.isArray(args) || args.length !== 1 || !COMMANDS.has(args[0])) {
    write(HELP);
    return 2;
  }
  const command = args[0];
  if (command === "help") { write(HELP); return 0; }
  if (command === "health") { write(JSON.stringify(await healthCheck()) + "\n"); return 0; }
  if (command === "status") {
    const health = await healthCheck();
    const status = await getAdminStatus({
      queryService: platform === "win32" ? readService : undefined,
      paired,
      health,
    });
    write(JSON.stringify(status, null, 2) + "\n");
    return 0;
  }
  if (platform !== "win32" || !interactive) {
    write("admin_confirmation_required: требуется локальная интерактивная консоль Windows\n");
    return 2;
  }

  const confirm = async action => {
    const phrase = `CONFIRM ${action.toUpperCase()} ${WINDOWS_SERVICE_NAME}`;
    return (await ask(`Введите ${phrase} для подтверждения: `)) === phrase;
  };
  try {
    if (command === "lock" || command === "unlock") {
      if (!emergencyPath) throw Object.assign(Error("emergency_lock_not_configured"), { code: "emergency_lock_not_configured" });
      if (!await confirm(command)) { write("admin_confirmation_denied\n"); return 2; }
      const marker = makeEmergencyLock(emergencyPath, { platform });
      write(JSON.stringify(await marker[command]()) + "\n");
      return 0;
    }
    if (CONTROL.has(command)) {
      const controller = makeController({ platform, authorization: confirm });
      const result = await controller.execute(command);
      write(JSON.stringify(result) + "\n");
      return 0;
    }
    // The challenge lives in this one interactive process and is consumed on
    // the first attempt, even if the user enters an invalid confirmation.
    const gate = makeRebootGate({ platform, authorization: confirm });
    const challenge = gate.prepare();
    write(`На ввод кода есть ${challenge.expires_in_seconds} секунд; после подтверждения перезагрузка будет назначена через 120 секунд.\n`);
    write(`Код подтверждения: ${challenge.code}\n`);
    const code = await ask("Повторите код дословно: ");
    try {
      const result = await gate.confirm(code);
      write(JSON.stringify(result) + "\n");
      write("Во время отсчёта нажмите Enter или закройте консоль для отмены.\n");
      const aborter = new AbortController();
      try {
        const cancelled = ask("Enter = ОТМЕНА: ", { signal: aborter.signal }).then(
          () => { gate.cancel(); return { status: "cancelled" }; },
          () => { gate.cancel(); return { status: "cancelled" }; },
        );
        const completed = await Promise.race([gate.wait(), cancelled]);
        write(JSON.stringify(completed) + "\n");
        return completed.status === "reboot_unavailable" ? 1 : 0;
      } finally { aborter.abort(); }
    } finally { gate.cancel(); }
  } catch (error) {
    // Never echo a child-process exception, stderr, or environment secrets.
    write((typeof error?.code === "string" ? error.code : "local_admin_unavailable") + "\n");
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runAdminCli();
}
