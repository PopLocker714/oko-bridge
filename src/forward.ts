import { config } from "./config";
import { log, redact } from "./log";
import { resolveSource, sourceKey } from "./source";
import type { DesiredCamera, CameraStatus } from "./api";

const isRtsp = (u: string) => /^rtsps?:\/\//i.test(u);
// Ключ идентичности форвардера: источник (RTSP или ONVIF-xaddr) + ingest. Смена любого → пересоздание.
const specKey = (cam: DesiredCamera) => sourceKey(cam) + "|" + cam.ingestUrl;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Один ffmpeg-процесс на камеру + backoff-супервизор. ffmpeg запускается МАССИВОМ argv (без shell, LOW-2).
class CameraForwarder {
  cameraId: string;
  ingestUrl: string;
  key: string;
  private spec: DesiredCamera;
  private proc: Bun.Subprocess | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private running = false;

  constructor(cam: DesiredCamera) {
    this.spec = cam;
    this.cameraId = cam.cameraId;
    this.ingestUrl = cam.ingestUrl;
    this.key = specKey(cam);
    void this.run();
  }

  // RTSP-режим → готовый sourceUrl. ONVIF-режим → резолвим свежий RTSP через GetStreamUri
  // (каждый реконнект — заново: устойчиво к смене URI, креды живут только в памяти агента).
  private async resolveSource(): Promise<string> {
    return resolveSource(this.spec);
  }

  private args(sourceUrl: string): string[] {
    // Шифрованный ингест: если ingestUrl = rtsps://, включаем TLS-верификацию сервера
    // (проверено эмпирически: ffmpeg публикует по rtsps; verify=1 даёт защиту от MITM).
    const tls = /^rtsps:\/\//i.test(this.ingestUrl)
      ? ["-tls_verify", config.ingestTlsVerify, ...(config.ingestCaFile ? ["-ca_file", config.ingestCaFile] : [])]
      : [];
    return [
      "ffmpeg", "-hide_banner", "-nostats", "-loglevel", "warning",
      "-rtsp_transport", config.rtspTransport,
      "-timeout", String(config.inputTimeoutSec * 1_000_000), // RTSP socket-таймаут (мкс): роняет ffmpeg на залипшем входе (M-2)
      "-i", sourceUrl,
      "-c:v", "copy", "-an", // video-only remux; аудио — позже
      ...tls,
      "-f", "rtsp", "-rtsp_transport", "tcp", this.ingestUrl,
    ];
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
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) log.warn("ffmpeg", { cameraId: this.cameraId, line: redact(line) });
        }
      }
    } catch {
      /* stream closed */
    }
  }

  private async run() {
    this.running = true;
    while (!this.stopped) {
      const started = Date.now();
      try {
        // ONVIF-резолв ДО запуска ffmpeg: если камера/креды недоступны — не плодим мёртвые процессы.
        const sourceUrl = await this.resolveSource();
        if (this.stopped) break;
        this.proc = Bun.spawn(this.args(sourceUrl), { stdout: "ignore", stderr: "pipe" });
        if (this.proc.stderr) this.pipeStderr(this.proc.stderr as ReadableStream<Uint8Array>);
        log.info("forward: старт", { cameraId: this.cameraId, mode: this.spec.onvif ? "onvif" : "rtsp" });
        await this.proc.exited;
      } catch (e) {
        log.error("forward: не удалось запустить/резолвить источник", { cameraId: this.cameraId, err: redact(String(e)) });
      }
      this.proc = null;
      if (this.stopped) break;
      if (Date.now() - started > 60_000) this.backoffMs = 1000; // стабильно работал → сброс backoff
      const jitter = this.backoffMs / 2 + Math.random() * (this.backoffMs / 2);
      const wait = Math.max(2000, jitter); // release-floor 2с: дать MediaMTX освободить path (HIGH-2)
      log.info("forward: реконнект", { cameraId: this.cameraId, waitMs: Math.round(wait) });
      await sleep(wait);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    }
    this.running = false;
  }

  stop() {
    this.stopped = true;
    try {
      this.proc?.kill(); // SIGTERM
    } catch {
      /* ignore */
    }
  }

  status(): string {
    return this.proc ? "publishing" : "reconnecting";
  }
}

// Реконсилирует множество форвардеров под desired-state с сервера.
export class ForwarderManager {
  private map = new Map<string, CameraForwarder>();

  reconcile(desired: DesiredCamera[]) {
    const want = new Map<string, DesiredCamera>();
    for (const cam of desired) {
      if (!cam.enabled) continue;
      // Источник валиден, если это RTSP (Этап 1) ИЛИ ONVIF-дескриптор (Этап 2).
      const ok = (cam.sourceUrl && isRtsp(cam.sourceUrl)) || !!cam.onvif?.url;
      if (!ok) {
        log.warn("forward: пропускаю камеру без валидного источника", { cameraId: cam.cameraId });
        continue;
      }
      want.set(cam.cameraId, cam);
    }
    // остановить лишние/выключенные/изменившиеся
    for (const [id, fwd] of this.map) {
      const w = want.get(id);
      if (!w || specKey(w) !== fwd.key) {
        fwd.stop();
        this.map.delete(id);
        log.info("forward: стоп", { cameraId: id });
      }
    }
    // запустить недостающие
    for (const [id, cam] of want) {
      if (!this.map.has(id)) this.map.set(id, new CameraForwarder(cam));
    }
  }

  statuses(): CameraStatus[] {
    return [...this.map.values()].map((f) => ({ cameraId: f.cameraId, status: f.status() }));
  }

  stopAll() {
    for (const f of this.map.values()) f.stop();
    this.map.clear();
  }
}
