# oko-bridge

The open-source edge agent for **oko-cloud** — connect your existing IP cameras to the cloud with **free ~7-day recording**, no port forwarding, no vendor lock-in.

`oko-bridge` is a tiny program you run on any device inside your camera's network (a mini-PC, a Raspberry Pi, an old laptop). It discovers ONVIF cameras automatically, pulls their RTSP streams, and forwards them to oko-cloud over an encrypted connection (RTSPS). One bridge covers every camera on the LAN.

It is a **pure client**: it holds no secrets of ours, talks to the cloud over plain HTTPS + RTSPS, and is small enough to read end-to-end. That's the point — you shouldn't have to trust a black box running on your own network.

## Install (one command)

Get a pairing code in your oko-cloud dashboard (**Bridge → Add**), then on your Linux device:

```sh
curl -fsSL https://api.tunnel.poploker.ru/install.sh | OKO_PAIR_CODE=YOUR_CODE sh
```

The installer detects your OS/architecture, downloads the matching binary from this repo's Releases, installs `ffmpeg` via your package manager, and sets up a `systemd` service with auto-start. Docker is **not** required.

After it pairs, the token is saved on the device — the code is one-time and no longer needed. Cameras on the network are discovered automatically; adopt them from the dashboard.

### Docker (alternative)

Prefer containers? A multi-arch image is published on every release:

```sh
docker run -d --name oko-bridge --restart unless-stopped --network host \
  -e OKO_API=https://api.tunnel.poploker.ru -e OKO_PAIR_CODE=YOUR_CODE \
  -v oko-bridge-data:/data ghcr.io/poplocker714/oko-bridge:latest
```

`--network host` is required on Linux for ONVIF multicast discovery.

## How it works

```
[IP cameras] --RTSP--> [oko-bridge on your LAN] --RTSPS (TLS)--> [oko-cloud] --> your dashboard
```

- **ONVIF discovery** — finds cameras via WS-Discovery, resolves their RTSP URLs.
- **Motion-based recording** — samples frames and only records/notifies on motion (configurable).
- **Encrypted ingest** — publishes over RTSPS with server-certificate verification; a per-bridge token authenticates the stream.
- **Self-healing** — survives camera IP changes (DHCP) via stable ONVIF device keys; the `systemd` service restarts on failure/reboot.

State (the pairing token) lives in `OKO_DATA_DIR` (default `/var/lib/oko-bridge` for the binary install, `/data` in Docker).

## Build from source

Requires [Bun](https://bun.sh) 1.3+ and `ffmpeg` at runtime.

```sh
bun install
# run directly
OKO_API=https://api.tunnel.poploker.ru OKO_PAIR_CODE=YOUR_CODE bun src/index.ts
# or compile a standalone binary for your target
bun build --compile --target=bun-linux-x64   src/index.ts --outfile oko-bridge-linux-x64
bun build --compile --target=bun-linux-arm64 src/index.ts --outfile oko-bridge-linux-arm64
```

CI (`.github/workflows/release.yml`) builds `linux-x64` + `linux-arm64` binaries and attaches them to a GitHub Release on every `v*` tag; `docker.yml` publishes the GHCR image.

## Configuration (environment)

| Variable | Default | Purpose |
|----------|---------|---------|
| `OKO_API` | — | oko-cloud API base URL (required) |
| `OKO_PAIR_CODE` | — | one-time pairing code (first run only) |
| `OKO_DATA_DIR` | `/data` | where the bridge token is persisted |
| `OKO_HEARTBEAT_SEC` | `30` | heartbeat interval |
| `OKO_RTSP_TRANSPORT` | `tcp` | RTSP transport (tcp is NAT-friendly) |
| `OKO_INGEST_TLS_VERIFY` | `1` | verify the cloud's TLS cert on RTSPS ingest |

## License

MIT — see [LICENSE](./LICENSE).
