import { resolveOnvifRtsp } from "./discovery/onvif";
import type { DesiredCamera } from "./api";

// Единый резолв источника камеры в RTSP-URL: готовый sourceUrl (Этап 1) ИЛИ ONVIF (Этап 2).
// Общий для форвардера и детектора движения.
export async function resolveSource(cam: DesiredCamera): Promise<string> {
  if (cam.sourceUrl) return cam.sourceUrl;
  if (cam.onvif) return await resolveOnvifRtsp(cam.onvif);
  throw new Error("нет источника (ни sourceUrl, ни onvif)");
}

// Ключ идентичности источника (без ingest) — для реконсиляции детекторов движения.
export const sourceKey = (cam: DesiredCamera) => cam.sourceUrl || cam.onvif?.url || "";
