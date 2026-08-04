import { config, requireApiBase, AGENT_VERSION } from "./config";
import { log } from "./log";
import { loadState, saveState, wipeState, loadPending, savePending, clearPending, type State } from "./state";
import { pair, registerDevice, claimStatus, heartbeat, reportMotion, RevokedError, type DiscoveredDevice } from "./api";
import { ForwarderManager } from "./forward";
import { MotionManager } from "./motion";
import { probe } from "./discovery/wsdiscovery";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Периодический ONVIF-скан LAN. Находки отдаём через onFound; heartbeat приложит их к следующему beat.
async function runDiscovery(onFound: (d: DiscoveredDevice[]) => void, stopped: () => boolean) {
  await sleep(3000); // дать агенту подняться после старта/привязки
  while (!stopped()) {
    try {
      const matches = await probe({ timeoutMs: 4000 });
      if (matches.length) {
        log.info("discovery: найдено ONVIF-устройств", { count: matches.length });
        onFound(matches.map((m) => ({ deviceKey: m.deviceKey, onvifUrl: m.onvifUrl, ip: m.ip, name: m.name, model: m.hardware })));
      } else {
        log.debug("discovery: ONVIF-камеры не найдены");
      }
    } catch (e) {
      log.warn("discovery: ошибка сканирования", { err: String(e) });
    }
    await sleep(config.discoveryIntervalSec * 1000);
  }
}

// Код устройства человек читает с экрана или из journalctl и вводит в кабинете —
// показываем его отдельным блоком, а не одной строкой в потоке структурных логов.
function showDeviceCode(code: string) {
  const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
  const line = "─".repeat(46);
  process.stdout.write(
    `\n${line}\n` +
      `  Устройство готово, но ещё не привязано.\n\n` +
      `  КОД УСТРОЙСТВА:  ${pretty}\n\n` +
      `  Личный кабинет → Bridge → «Забрать устройство»\n` +
      `  Код действует, пока устройство не заберут.\n` +
      `${line}\n\n`
  );
  log.info("bridge: ожидает забора владельцем", { deviceCode: pretty });
}

// Ждём, пока владелец заберёт устройство в кабинете. Спешить некуда — опрос редкий,
// а само ожидание и есть смысл обратного потока: коробку можно поставить заранее.
async function waitForClaim(apiBase: string): Promise<State> {
  let pending = await loadPending();
  if (!pending || pending.apiBase !== apiBase) {
    const { deviceCode, deviceSecret } = await registerDevice(apiBase);
    pending = { apiBase, deviceCode, deviceSecret };
    await savePending(pending);
    log.info("bridge: зарегистрирован в облаке");
  }
  showDeviceCode(pending.deviceCode);
  let announced = 0;
  for (;;) {
    const r = await claimStatus(apiBase, pending.deviceSecret);
    if (r.claimed) {
      const state: State = { apiBase, bridgeId: r.bridgeId, token: r.token, agentVersion: AGENT_VERSION };
      await saveState(state);
      await clearPending();
      log.info("bridge: устройство забрано, привязка завершена", { bridgeId: r.bridgeId });
      return state;
    }
    // Раз в 5 минут повторяем код в логе — чтобы его не пришлось искать в старых строках.
    if (++announced % 60 === 0) showDeviceCode(pending.deviceCode);
    await sleep(config.claimPollSec * 1000);
  }
}

async function ensurePaired(): Promise<State> {
  const existing = await loadState();
  if (existing?.token) {
    log.info("bridge: используем сохранённую привязку", { bridgeId: existing.bridgeId });
    return existing;
  }
  const apiBase = requireApiBase();
  // Путь с кодом из кабинета остаётся основным, если код задан явно.
  if (config.pairCode) {
    log.info("bridge: привязка по коду…");
    const { bridgeId, token } = await pair(apiBase, config.pairCode);
    const state: State = { apiBase, bridgeId, token, agentVersion: AGENT_VERSION };
    await saveState(state);
    log.info("bridge: привязан", { bridgeId });
    return state;
  }
  // Кода нет — разворачиваем поток: объявляем себя и ждём, пока заберут.
  return waitForClaim(apiBase);
}

async function main() {
  log.info("oko-bridge запускается", { version: AGENT_VERSION });
  const state = await ensurePaired();
  const manager = new ForwarderManager();
  // Детекторы движения пингуют облако; событие/запись/уведомление — на стороне backend.
  const motion = new MotionManager((cameraId) => reportMotion(state.apiBase, state.token, cameraId));

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log.info("bridge: остановка (SIGTERM)");
    manager.stopAll();
    motion.stopAll();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ONVIF-обнаружение: находки копятся в pendingDiscovered и уходят в теле heartbeat.
  let pendingDiscovered: DiscoveredDevice[] = [];
  let discoveredDirty = false;
  if (config.discoveryEnabled) {
    void runDiscovery(
      (d) => {
        pendingDiscovered = d;
        discoveredDirty = true;
      },
      () => stopping
    );
  }

  // Desired-state приходит в ответе heartbeat.
  let intervalMs = config.heartbeatSec * 1000;
  let backoffMs = 0;

  while (!stopping) {
    // Снимок находок берём и гасим флаг СИНХРОННО до await (без гонки с колбэком discovery).
    const toSend = discoveredDirty ? pendingDiscovered : undefined;
    discoveredDirty = false;
    try {
      const res = await heartbeat(state.apiBase, state.token, manager.statuses(), toSend);
      manager.reconcile(res.cameras); // применяем ТОЛЬКО при успешном 200 (M-5)
      motion.reconcile(res.cameras); // детекторы движения — из того же desired-state
      intervalMs = res.intervalMs;
      backoffMs = 0;
    } catch (e) {
      if (toSend) discoveredDirty = true; // heartbeat не прошёл — переотправим находки следующим beat
      if (e instanceof RevokedError) {
        log.error("bridge: токен отозван — останавливаемся и стираем привязку");
        manager.stopAll();
        await wipeState();
        process.exit(0); // restart:unless-stopped перезапустит для нового пейринга
      }
      // Транзиентный сбой: НЕ трогаем форвардеры, ретраим с backoff (M-5).
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 5000, intervalMs);
      log.warn("bridge: heartbeat не прошёл, ретрай", { err: String(e), waitMs: backoffMs });
      await sleep(backoffMs);
      continue;
    }
    await sleep(intervalMs);
  }
}

main().catch((e) => {
  log.error("bridge: фатальная ошибка", { err: String(e) });
  process.exit(1);
});
