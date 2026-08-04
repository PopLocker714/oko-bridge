import { join } from "node:path";
import { chmod, rename, unlink } from "node:fs/promises";
import { config } from "./config";

// Постоянное состояние агента: apiBase + bridgeId + token. Атомарная запись (temp+rename), права 0600.
export type State = { apiBase: string; bridgeId: string; token: string; agentVersion?: string };

const FILE = () => join(config.dataDir, "state.json");

export async function loadState(): Promise<State | null> {
  try {
    const f = Bun.file(FILE());
    if (!(await f.exists())) return null;
    const s = JSON.parse(await f.text());
    if (s && typeof s.token === "string" && typeof s.bridgeId === "string" && typeof s.apiBase === "string") return s;
    return null;
  } catch {
    return null;
  }
}

export async function saveState(s: State): Promise<void> {
  const tmp = FILE() + ".tmp";
  await Bun.write(tmp, JSON.stringify(s));
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, FILE());
}

// Промежуточное состояние обратной привязки: устройство уже зарегистрировано в облаке,
// но владелец ещё не забрал его в кабинете. Лежит на диске, чтобы код устройства
// пережил рестарт сервиса — иначе человек читает код в логе, идёт в ЛК, а там уже другой.
export type Pending = { apiBase: string; deviceCode: string; deviceSecret: string };

const PENDING_FILE = () => join(config.dataDir, "pending.json");

export async function loadPending(): Promise<Pending | null> {
  try {
    const f = Bun.file(PENDING_FILE());
    if (!(await f.exists())) return null;
    const s = JSON.parse(await f.text());
    if (s && typeof s.deviceCode === "string" && typeof s.deviceSecret === "string" && typeof s.apiBase === "string") return s;
    return null;
  } catch {
    return null;
  }
}

export async function savePending(p: Pending): Promise<void> {
  const tmp = PENDING_FILE() + ".tmp";
  await Bun.write(tmp, JSON.stringify(p));
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, PENDING_FILE());
}

export async function clearPending(): Promise<void> {
  await unlink(PENDING_FILE()).catch(() => {});
}

export async function wipeState(): Promise<void> {
  try {
    await Bun.write(FILE(), "");
    await rename(FILE(), FILE() + ".revoked").catch(() => {});
  } catch {
    /* ignore */
  }
}
