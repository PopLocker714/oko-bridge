// Детектор движения на bridge (Этап 3). Лёгкий ffmpeg на камеру: покадровая разница
// (tblend=difference) → signalstats.YAVG. Порог отсекает шум сенсора (проверено: статика 0,
// шум ~2.3, реальное движение ~8.5 — дефолтный порог 5). При движении пингуем backend;
// событие/запись/уведомление и закрытие по cooldown — на стороне облака.
import { config } from "./config";
import { log, redact } from "./log";
import { resolveSource, sourceKey } from "./source";
import type { DesiredCamera } from "./api";

const FRAMES_NEEDED = 2; // столько подряд «горячих» кадров, чтобы не среагировать на одиночный шумовой всплеск
const PING_INTERVAL_MS = 7000; // не чаще одного пинга движения в этот интервал, пока движение длится
const isRtsp = (u: string) => /^rtsps?:\/\//i.test(u);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class MotionDetector {
  cameraId: string;
  key: string;
  private spec: DesiredCamera;
  private report: (cameraId: string) => void;
  private proc: Bun.Subprocess | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private hot = 0;
  private lastPing = 0;

  constructor(cam: DesiredCamera, report: (cameraId: string) => void) {
    this.spec = cam;
    this.cameraId = cam.cameraId;
    this.key = sourceKey(cam);
    this.report = report;
    void this.run();
  }

  private args(src: string): string[] {
    return [
      "ffmpeg", "-hide_banner", "-nostats", "-loglevel", "info",
      "-rtsp_transport", config.rtspTransport,
      "-timeout", String(config.inputTimeoutSec * 1_000_000),
      "-i", src,
      "-an",
      // fps ↓ + res ↓ + gray → дёшево; tblend=difference = разница соседних кадров; печатаем только YAVG.
      "-vf", `fps=${config.motionFps},scale=160:120,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
      "-f", "null", "-",
    ];
  }

  private onYavg(yavg: number) {
    if (yavg >= config.motionThreshold) {
      if (++this.hot >= FRAMES_NEEDED) {
        const now = Date.now();
        if (now - this.lastPing >= PING_INTERVAL_MS) {
          this.lastPing = now;
          this.report(this.cameraId); // best-effort пинг движения
        }
      }
    } else {
      this.hot = 0;
    }
  }

  private async pipeStderr(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const m = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(line);
          if (m) this.onYavg(parseFloat(m[1]));
          else if (/error|failed|Connection refused/i.test(line)) log.warn("motion ffmpeg", { cameraId: this.cameraId, line: redact(line.trim()) });
        }
      }
    } catch {
      /* stream closed */
    }
  }

  private async run() {
    while (!this.stopped) {
      const started = Date.now();
      try {
        const src = await resolveSource(this.spec);
        if (this.stopped) break;
        this.proc = Bun.spawn(this.args(src), { stdout: "ignore", stderr: "pipe" });
        if (this.proc.stderr) this.pipeStderr(this.proc.stderr as ReadableStream<Uint8Array>);
        log.info("motion: детектор запущен", { cameraId: this.cameraId, threshold: config.motionThreshold });
        await this.proc.exited;
      } catch (e) {
        log.warn("motion: сбой детектора", { cameraId: this.cameraId, err: redact(String(e)) });
      }
      this.proc = null;
      this.hot = 0;
      if (this.stopped) break;
      if (Date.now() - started > 60_000) this.backoffMs = 1000; // работал стабильно → сброс backoff
      await sleep(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    }
  }

  stop() {
    this.stopped = true;
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
  }
}

// Реконсилирует детекторы под desired-state: детектим только камеры с motion:true и валидным источником.
export class MotionManager {
  private map = new Map<string, MotionDetector>();
  private report: (cameraId: string) => void;

  constructor(report: (cameraId: string) => void) {
    this.report = report;
  }

  reconcile(desired: DesiredCamera[]) {
    const want = new Map<string, DesiredCamera>();
    for (const cam of desired) {
      if (!cam.enabled || !cam.motion) continue;
      const hasSource = (cam.sourceUrl && isRtsp(cam.sourceUrl)) || !!cam.onvif?.url;
      if (hasSource) want.set(cam.cameraId, cam);
    }
    for (const [id, det] of this.map) {
      const w = want.get(id);
      if (!w || sourceKey(w) !== det.key) {
        det.stop();
        this.map.delete(id);
        log.info("motion: детектор остановлен", { cameraId: id });
      }
    }
    for (const [id, cam] of want) {
      if (!this.map.has(id)) this.map.set(id, new MotionDetector(cam, this.report));
    }
  }

  stopAll() {
    for (const d of this.map.values()) d.stop();
    this.map.clear();
  }
}
