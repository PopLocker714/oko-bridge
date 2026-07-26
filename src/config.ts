// Конфиг агента из env. На первом старте нужен OKO_API + OKO_PAIR_CODE (или уже сохранённый state).
export const AGENT_VERSION = "0.4.0"; // Этап 4: нативная установка бинарником + systemd (без Docker)

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} обязателен`);
  return v;
}

export const config = {
  apiBase: (process.env.OKO_API || "").replace(/\/+$/, ""), // напр. https://api.tunnel.poploker.ru
  pairCode: process.env.OKO_PAIR_CODE || "",
  dataDir: process.env.OKO_DATA_DIR || "/data",
  heartbeatSec: Number(process.env.OKO_HEARTBEAT_SEC || 30),
  rtspTransport: process.env.OKO_RTSP_TRANSPORT || "tcp", // tcp надёжнее за NAT
  inputTimeoutSec: Number(process.env.OKO_INPUT_TIMEOUT_SEC || 15), // -rw_timeout: роняет ffmpeg на залипшем входе
  // Шифрованный ингест (rtsps): верифицировать серверный cert. "1" — да (реальный/LE cert, защита от MITM),
  // "0" — только для self-signed (защита лишь от пассивного прослушивания). ingestCaFile — свой CA для пиннинга.
  ingestTlsVerify: process.env.OKO_INGEST_TLS_VERIFY === "0" ? "0" : "1",
  ingestCaFile: process.env.OKO_INGEST_CA_FILE || "",
  logLevel: process.env.OKO_LOG_LEVEL || "info",
  // ONVIF-обнаружение камер в LAN (Этап 2). OKO_DISCOVERY=0 отключает.
  discoveryEnabled: process.env.OKO_DISCOVERY !== "0",
  discoveryIntervalSec: Number(process.env.OKO_DISCOVERY_SEC || 300), // как часто сканируем сеть
  // Детекция движения (Этап 3). Порог YAVG разностного кадра: статика ~0, шум ~2.3, движение ~8+.
  motionThreshold: Number(process.env.OKO_MOTION_THRESHOLD || 5),
  motionFps: Number(process.env.OKO_MOTION_FPS || 4), // частота анализа (дёшево)
};

export function requireApiBase(): string {
  if (!config.apiBase) throw new Error("env OKO_API обязателен (адрес API oko-cloud)");
  return config.apiBase;
}
export { req };
