import { config, requireApiBase, AGENT_VERSION } from "./config";
import { log } from "./log";
import { loadState, saveState, wipeState, type State } from "./state";
import { pair, heartbeat, reportMotion, RevokedError, type DiscoveredDevice } from "./api";
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

async function ensurePaired(): Promise<State> {
  const existing = await loadState();
  if (existing?.token) {
    log.info("bridge: используем сохранённую привязку", { bridgeId: existing.bridgeId });
    return existing;
  }
  const apiBase = requireApiBase();
  if (!config.pairCode) {
    throw new Error("нет сохранённой привязки и не задан OKO_PAIR_CODE — получите код в личном кабинете");
  }
  log.info("bridge: привязка по коду…");
  const { bridgeId, token } = await pair(apiBase, config.pairCode);
  const state: State = { apiBase, bridgeId, token, agentVersion: AGENT_VERSION };
  await saveState(state);
  log.info("bridge: привязан", { bridgeId });
  return state;
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
