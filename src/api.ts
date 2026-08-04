import { AGENT_VERSION } from "./config";

// Клиент API oko-cloud. 401 на bridge-эндпоинтах = токен отозван → RevokedError (агент стирает state).
export class RevokedError extends Error {}

// Камера может прийти в одном из двух режимов:
//  • RTSP (Этап 1): готовый sourceUrl.
//  • ONVIF (Этап 2): дескриптор onvif — агент сам резолвит RTSP через GetStreamUri.
export type DesiredCamera = {
  cameraId: string;
  path: string;
  enabled: boolean;
  ingestUrl: string;
  sourceUrl?: string;
  onvif?: { url: string; username: string; password: string };
  motion?: boolean; // детектить движение (запись по движению или включены уведомления) — Этап 3
};
export type CameraStatus = { cameraId: string; status: string };
// Найденное в LAN ONVIF-устройство (агент → облако, прикладывается к heartbeat).
export type DiscoveredDevice = {
  deviceKey: string;
  onvifUrl: string;
  ip?: string;
  name?: string;
  manufacturer?: string;
  model?: string;
};

export async function pair(apiBase: string, code: string): Promise<{ bridgeId: string; token: string }> {
  const r = await fetch(`${apiBase}/api/bridges/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingCode: code }),
  });
  if (!r.ok) throw new Error(`pair failed: HTTP ${r.status}`);
  const j = (await r.json()) as { bridgeId: string; token: string };
  if (!j.token) throw new Error("pair: нет токена в ответе");
  return j;
}

// Обратная привязка. Устройство регистрируется само и получает пару:
//  • deviceCode   — для человека, он вводит его в кабинете;
//  • deviceSecret — только для устройства, им опрашивается статус забора.
export async function registerDevice(apiBase: string): Promise<{ deviceCode: string; deviceSecret: string }> {
  const r = await fetch(`${apiBase}/api/bridges/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentVersion: AGENT_VERSION }),
  });
  if (!r.ok) throw new Error(`register failed: HTTP ${r.status}`);
  const j = (await r.json()) as { deviceCode: string; deviceSecret: string };
  if (!j.deviceCode || !j.deviceSecret) throw new Error("register: неполный ответ");
  return j;
}

// Опрос статуса. Пока владелец не забрал — claimed:false. После забора приходит боевой
// токен, ровно один раз: секрет на стороне облака гасится тем же запросом.
export async function claimStatus(
  apiBase: string,
  deviceSecret: string
): Promise<{ claimed: false } | { claimed: true; bridgeId: string; token: string }> {
  const r = await fetch(`${apiBase}/api/bridges/claim-status`, {
    headers: { authorization: `Bearer ${deviceSecret}` },
  });
  if (r.status === 401) throw new RevokedError("секрет устройства недействителен");
  if (!r.ok) throw new Error(`claim-status failed: HTTP ${r.status}`);
  return (await r.json()) as { claimed: false } | { claimed: true; bridgeId: string; token: string };
}

// Пинг движения (Этап 3): best-effort, облако создаёт событие/включает запись/уведомляет.
export async function reportMotion(apiBase: string, token: string, cameraId: string): Promise<void> {
  try {
    await fetch(`${apiBase}/api/bridge/motion`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ cameraId }),
    });
  } catch {
    /* пинг движения не критичен — молча пропускаем */
  }
}

export async function heartbeat(
  apiBase: string,
  token: string,
  cameras: CameraStatus[],
  discovered?: DiscoveredDevice[]
): Promise<{ intervalMs: number; cameras: DesiredCamera[] }> {
  const body: Record<string, unknown> = { agentVersion: AGENT_VERSION, cameras };
  if (discovered && discovered.length) body.discovered = discovered; // ONVIF-находки, если есть
  const r = await fetch(`${apiBase}/api/bridge/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new RevokedError("bridge токен отозван (401)");
  if (!r.ok) throw new Error(`heartbeat: HTTP ${r.status}`);
  const j = (await r.json()) as { intervalMs?: number; cameras?: DesiredCamera[] };
  if (!Array.isArray(j.cameras)) throw new Error("heartbeat: некорректный desired-state");
  return { intervalMs: j.intervalMs || 30_000, cameras: j.cameras };
}
