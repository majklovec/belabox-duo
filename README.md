# srtla_relay

Bun-based controller for BELABOX-style bonded streaming. One program covers
three device types, and an optional control server manages a fleet of them
from a browser.

| Role (`--role`) | What it does |
|---|---|
| `relay` (default) | Receives SRT from an encoder and sends it out bonded over all uplinks with `srtla_send`. Manages source routing, the uplinks file and modems (ModemManager). |
| `encoder` | Runs `belacoder` with a GStreamer pipeline and sends SRT to a relay. No routing, modems or `srtla_send`, so it does not need root. |
| `combined` | Encoder and relay in one box: `belacoder` → local `srtla_send` → bonded uplinks. One Start/Stop drives both. |

```
encoder ──SRT──▶ relay ──SRTLA (bonded)──▶ SRTLA receiver
combined ─────────SRTLA (bonded)─────────▶ SRTLA receiver
        ▲                ▲
        └── control server (optional, WebSocket) ──┘
```

Requires [Bun](https://bun.sh), plus `srtla_send` (relay/combined), `belacoder`
and GStreamer (encoder/combined), and `iproute2` / ModemManager for bonding.

## Running

```sh
# Relay: local web UI + API on :8085, watches interfaces and reloads srtla_send
sudo bun srtla_relay.ts --api --host 0.0.0.0

# Encoder: pick a pipeline and the relay's SRT port in the UI
bun srtla_relay.ts --api --role encoder --pipelines /usr/share/belacoder/pipelines

# Combined
sudo bun srtla_relay.ts --api --role combined --pipelines /usr/share/belacoder/pipelines

# One-shot (relay): set up routing + uplinks file, optionally start srtla_send
sudo bun srtla_relay.ts --start-srtla 6000 rec.example.com 5000 --monitor
```

Open `http://<device>:8085/`. The UI shows only what applies to the role.

### Options

| Option | Env | Default | Notes |
|---|---|---|---|
| `--role` | `SRTLA_ROLE` | `relay` | `relay`, `encoder`, `combined` |
| `--api`, `--host`, `--port` | | off, `127.0.0.1`, `8085` | Local web UI and WebSocket API (`/ws`) |
| `--allow-origin` | | | Extra browser origins for `/ws` (comma-separated, `*` = any) |
| `--state` | | `$TMPDIR/srtla_state.json` | Persist selection, last stream and autostart. **Use a persistent path in production.** |
| `--config` | | `modems.json` | Optional default bonding selection `{"modems": [...]}` or `{"ips": [...]}` |
| `--uplinks` | | `$TMPDIR/srtla_ips.txt` | Uplinks file for `srtla_send` |
| `--monitor` | | on with `--api`/`--remote` | Watch interfaces and reconfigure on change (relay/combined) |
| `--srtla-reload` | | `signal` | `signal` (SIGHUP) or `restart` |
| `--debounce-ms` | | `1500` | Interface event debounce |
| `--pipelines` | `BELACODER_PIPELINES` | `/usr/share/belacoder/pipelines` | Pipeline files, including subdirectories |
| `--belacoder` | `BELACODER_BIN` | `belacoder` | |
| | `SRTLA_SEND_BIN` | `srtla_send` | |
| `--bitrate-file` | | `$TMPDIR/belacoder_br` | belacoder bitrate file (re-read on SIGHUP) |
| `--remote` | `SRTLA_REMOTE_URL` | | Control server, e.g. `wss://ctl.example.com/device` |
| `--remote-token` | `SRTLA_REMOTE_TOKEN` | | Prefer the env var (keeps it out of `ps`) |
| `--remote-id` | `SRTLA_REMOTE_ID` | hostname | Device id shown on the server |
| `--remote-interval` | | `30` | Periodic status push in seconds (`0` = only on change) |
| `--dry-run` | | | Print `ip` / process actions instead of running them |

### Encoder pipelines

Pipelines are the belacoder GStreamer files under `--pipelines`, grouped by
subdirectory (`generic/`, `rk3588/`, `jetson/`, `custom/`, …). Before launch the
pipeline is adapted like belaUI does: choose the ALSA audio card or drop audio,
switch AAC to Opus, and keep or remove the bitrate overlay. `belacoder` and
`srtla_send` are restarted automatically if they exit.

### Autostart

Tick **Autostart** in the UI (or call `autostart.set`) to resume the last stream
whenever the service starts. It retries every 5 s until it succeeds (capture
card, uplinks or receiver not ready yet); any manual Start/Stop cancels a
pending retry.

## Control server

`server/server.ts` lists all devices and serves the same web UI for each one at
`/d/<id>/`, relaying commands to the device over its outbound connection, so
devices behind NAT or on mobile networks can be managed.

```sh
SRTLA_DEVICE_TOKEN=devsecret SRTLA_UI_PASSWORD=uipass bun server/server.ts --port 8090

# on each device
SRTLA_REMOTE_TOKEN=devsecret bun srtla_relay.ts --role encoder --remote wss://ctl.example.com/device --remote-id cam1
```

| Option | Env | Notes |
|---|---|---|
| `--host`, `--port` | | default `0.0.0.0:8090` |
| `--device-token` | `SRTLA_DEVICE_TOKEN` | Shared device token |
| `--devices` | | JSON file with per-device tokens `{"cam1": "token"}` |
| `--ui-user`, `--ui-password` | `SRTLA_UI_USER`, `SRTLA_UI_PASSWORD` | Browser login (HTTP Basic, user defaults to `admin`) |
| `--no-auth` | | Local testing only |

Run it behind a TLS reverse proxy: tokens and Basic auth need `wss://`/`https://`.

## Deployment (systemd)

```sh
sudo cp -r . /opt/srtla_relay
sudo cp deploy/srtla-relay.service /etc/systemd/system/
sudo cp deploy/srtla-relay.env /etc/default/srtla-relay   # set SRTLA_ROLE etc.
sudo systemctl enable --now srtla-relay

# control server host
sudo cp deploy/srtla-control.service /etc/systemd/system/
sudo cp deploy/srtla-control.env /etc/default/srtla-control
sudo systemctl enable --now srtla-control
```

The units expect Bun at `/usr/local/bin/bun`. The device unit keeps its state
in `/var/lib/srtla-relay/`, which autostart needs to survive a reboot.

## API

The local `/ws` endpoint and the control server speak the same JSON protocol:
requests `{ "id", "method", "params" }`, responses `{ "type": "response", "id", "ok", ... }`,
and pushed `{ "type": "event", "event": "status", "data": ... }`. The method list
is at the top of [src/api.ts](src/api.ts). Methods that do not apply to the
device's role are rejected with code 409.
