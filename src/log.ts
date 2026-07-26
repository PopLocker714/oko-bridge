// JSON-логи в stdout с редакцией секретов. Применяется И к stderr ffmpeg (LOW-3):
// ffmpeg сам печатает rtsp://user:pass@… и rtsp://pub:TOKEN@… — их надо затирать.
export function redact(s: string): string {
  return String(s)
    .replace(/(rtsps?:\/\/)[^@\s/]+@/gi, "$1***@") // rtsp://user:pass@ и rtsp://pub:token@
    .replace(/okb_[0-9a-f]{8,}/gi, "okb_***"); // bridge-токены
}

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[process.env.OKO_LOG_LEVEL || "info"] ?? 20;

function emit(level: string, msg: string, extra?: Record<string, unknown>) {
  if ((LEVELS[level] ?? 20) < min) return;
  const line: Record<string, unknown> = { level, msg: redact(msg) };
  if (extra) for (const [k, v] of Object.entries(extra)) line[k] = typeof v === "string" ? redact(v) : v;
  console.log(JSON.stringify(line));
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => emit("debug", m, e),
  info: (m: string, e?: Record<string, unknown>) => emit("info", m, e),
  warn: (m: string, e?: Record<string, unknown>) => emit("warn", m, e),
  error: (m: string, e?: Record<string, unknown>) => emit("error", m, e),
};
