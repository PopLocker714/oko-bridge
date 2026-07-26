// WS-Discovery (ONVIF) на сыром node:dgram — без нативных биндингов, Bun-native.
// Отправляем SOAP-Probe на multicast 239.255.255.250:3702; ответы ProbeMatch приходят
// ЮНИКАСТОМ на порт нашего сокета, поэтому addMembership не нужен (снимает вопрос
// совместимости Bun с multicast-приёмом — мы только отправляем в группу).
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";

const MCAST = "239.255.255.250";
const PORT = 3702;

export type ProbeMatch = {
  deviceKey: string; // urn устройства (EndpointReference/Address) — стабильный id, ключ дедупа
  onvifUrl: string; // xaddr — URL device_service (http://ip[:port]/onvif/device_service)
  ip: string;
  name?: string;
  hardware?: string;
};

const probeXml = (id: string) => `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
 xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
 xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
 xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
 <e:Header>
  <w:MessageID>uuid:${id}</w:MessageID>
  <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
  <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
 </e:Header>
 <e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>
</e:Envelope>`;

function parseProbeMatch(xml: string, fromIp: string): ProbeMatch | null {
  // XAddrs — обязателен; берём первый http(s) URL.
  const xaddrs = (/<[\w:]*XAddrs>\s*([^<]+)</i.exec(xml)?.[1] || "").trim();
  const onvifUrl = xaddrs.split(/\s+/).find((u) => /^https?:\/\//i.test(u));
  if (!onvifUrl) return null;
  const ip = /^https?:\/\/([^/:]+)/i.exec(onvifUrl)?.[1] || fromIp;
  // deviceKey — urn/uuid из EndpointReference/Address (стабилен при перезагрузке камеры); fallback — xaddr.
  const addr = /<[\w:]*Address>\s*(urn:[^<\s]+|uuid:[^<\s]+)\s*<\/[\w:]*Address>/i.exec(xml)?.[1];
  const deviceKey = (addr || onvifUrl).trim();
  const scopes = /<[\w:]*Scopes[^>]*>\s*([^<]+)</i.exec(xml)?.[1] || "";
  const pick = (re: RegExp) => {
    const raw = re.exec(scopes)?.[1];
    if (!raw) return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };
  return {
    deviceKey,
    onvifUrl,
    ip,
    name: pick(/onvif:\/\/www\.onvif\.org\/name\/(\S+)/i),
    hardware: pick(/onvif:\/\/www\.onvif\.org\/hardware\/(\S+)/i),
  };
}

// Один probe-цикл: ретрансмит 3× (UDP теряется), сбор ответов ~timeoutMs, дедуп по deviceKey.
export async function probe(opts: { timeoutMs?: number } = {}): Promise<ProbeMatch[]> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const found = new Map<string, ProbeMatch>();
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve([...found.values()]);
    };
    sock.on("error", finish);
    sock.on("message", (buf, rinfo) => {
      const m = parseProbeMatch(buf.toString(), rinfo.address);
      if (m) found.set(m.deviceKey, m);
    });
    sock.bind(0, () => {
      try {
        sock.setMulticastTTL(2);
      } catch {
        /* not fatal */
      }
      const send = () => sock.send(probeXml(randomUUID()), PORT, MCAST, () => {});
      send();
      setTimeout(send, 400);
      setTimeout(send, 1200);
      setTimeout(finish, timeoutMs);
    });
  });
}
