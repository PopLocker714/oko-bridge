// Минимальный ONVIF-клиент: GetCapabilities → GetProfiles → GetStreamUri.
// SOAP 1.2 + WS-Security UsernameToken (PasswordDigest = Base64(SHA1(nonce+created+password))).
// Никаких зависимостей: fetch + node:crypto. Покрывает Media1 (ver10/media) — почти весь парк IP-камер.
import { createHash, randomBytes } from "node:crypto";

const DEVICE_NS = "http://www.onvif.org/ver10/device/wsdl";
const MEDIA_NS = "http://www.onvif.org/ver10/media/wsdl";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
}

// WS-Security заголовок с дайджестом пароля (стандарт WSSE UsernameToken Profile 1.0).
function wsseHeader(username: string, password: string): string {
  const created = new Date().toISOString();
  const nonce = randomBytes(16);
  const digest = createHash("sha1")
    .update(Buffer.concat([nonce, Buffer.from(created, "utf8"), Buffer.from(password, "utf8")]))
    .digest("base64");
  return (
    `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">` +
    `<UsernameToken><Username>${esc(username)}</Username>` +
    `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>` +
    `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</Nonce>` +
    `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>` +
    `</UsernameToken></Security></s:Header>`
  );
}

async function soap(url: string, action: string, username: string, password: string, body: string, timeoutMs = 10_000): Promise<string> {
  const env =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${wsseHeader(username, password)}<s:Body>${body}</s:Body></s:Envelope>`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": `application/soap+xml; charset=utf-8; action="${action}"` },
      body: env,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ONVIF HTTP ${res.status} (${action.split("/").pop()})`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

// Media-сервис может жить на отдельном xaddr — узнаём через GetCapabilities. Fallback: сам device_service.
async function getMediaUrl(deviceUrl: string, username: string, password: string): Promise<string> {
  try {
    const xml = await soap(
      deviceUrl,
      `${DEVICE_NS}/GetCapabilities`,
      username,
      password,
      `<GetCapabilities xmlns="${DEVICE_NS}"><Category>Media</Category></GetCapabilities>`
    );
    const media = /<[\w:]*Media\b[^>]*>[\s\S]*?<[\w:]*XAddr>\s*([^<]+)</i.exec(xml)?.[1]?.trim();
    if (media && /^https?:\/\//i.test(media)) {
      // Камера иногда отдаёт нероутируемый хост (localhost/0.0.0.0) — чиним на IP устройства.
      const m = new URL(media);
      if (/^(localhost|127\.|0\.0\.0\.0)/.test(m.hostname)) m.hostname = new URL(deviceUrl).hostname;
      return m.toString();
    }
  } catch {
    /* многие камеры принимают Media-запросы прямо на device_service */
  }
  return deviceUrl;
}

async function getProfileToken(mediaUrl: string, username: string, password: string): Promise<string> {
  const xml = await soap(mediaUrl, `${MEDIA_NS}/GetProfiles`, username, password, `<GetProfiles xmlns="${MEDIA_NS}"/>`);
  const token = /<[\w:]*Profiles\b[^>]*\btoken="([^"]+)"/i.exec(xml)?.[1];
  if (!token) throw new Error("ONVIF: у камеры нет медиа-профилей");
  return token; // первый профиль = основной поток (main)
}

async function getStreamUri(mediaUrl: string, profileToken: string, username: string, password: string): Promise<string> {
  const body =
    `<GetStreamUri xmlns="${MEDIA_NS}"><StreamSetup xmlns:tt="http://www.onvif.org/ver10/schema">` +
    `<tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></StreamSetup>` +
    `<ProfileToken>${esc(profileToken)}</ProfileToken></GetStreamUri>`;
  const xml = await soap(mediaUrl, `${MEDIA_NS}/GetStreamUri`, username, password, body);
  const uri = /<[\w:]*Uri>\s*(rtsps?:\/\/[^<]+)\s*<\/[\w:]*Uri>/i.exec(xml)?.[1]?.trim();
  if (!uri) throw new Error("ONVIF: RTSP-URI не найден в ответе GetStreamUri");
  return uri;
}

// Вшиваем креды в RTSP-URL (ffmpeg нужен rtsp://user:pass@host/…). Стираем существующий userinfo,
// чиним нероутируемый хост на IP устройства, percent-энкодим логин/пароль.
function injectCreds(rtsp: string, username: string, password: string, deviceHost: string): string {
  const m = /^(rtsps?:\/\/)(?:[^@/]*@)?(.*)$/i.exec(rtsp);
  if (!m) return rtsp;
  const rest = m[2].replace(/^([^/:?]+)/, (h) => (/^(localhost|127\.\d|0\.0\.0\.0)/.test(h) && deviceHost ? deviceHost : h));
  return `${m[1]}${encodeURIComponent(username)}:${encodeURIComponent(password)}@${rest}`;
}

// Полный резолв: xaddr + креды → готовый RTSP-URL с логином/паролем.
export async function resolveOnvifRtsp(o: { url: string; username: string; password: string }): Promise<string> {
  const deviceHost = /^https?:\/\/([^/:]+)/i.exec(o.url)?.[1] || "";
  const mediaUrl = await getMediaUrl(o.url, o.username, o.password);
  const token = await getProfileToken(mediaUrl, o.username, o.password);
  const rtsp = await getStreamUri(mediaUrl, token, o.username, o.password);
  return injectCreds(rtsp, o.username, o.password, deviceHost);
}
