# WebRTC Phone

A browser-based 1:1 audio calling app. Two people open the same room link and talk in real time — peer-to-peer via WebRTC, no accounts, no plugins. A personal learning project for understanding WebRTC end-to-end (raw browser APIs, no PeerJS/Twilio abstractions).

**New to WebRTC?** Read [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) — a tour of signaling, SDP, ICE/STUN/TURN, and perfect negotiation using this codebase as the example.

## How it works

- **`client/`** — React + Vite + TypeScript app. Captures the mic (`getUserMedia`), manages the `RTCPeerConnection`, renders the call UI. All WebRTC + socket logic lives in one hook: `src/hooks/useCall.ts`.
- **`server/`** — Node + Express + Socket.io signaling server (`src/index.ts`). Holds the room registry and relays SDP descriptions and ICE candidates during the handshake. Once connected, audio flows directly between the two browsers and the server sits idle.

## Quick start

```bash
# Terminal 1 — signaling server (port 3001)
cd server && npm install && npm run dev

# Terminal 2 — client (port 5173)
cd client && npm install && npm run dev
```

Open `http://localhost:5173` in two browser tabs (or windows), create a room in one, and open the copied link (or enter the code) in the other.

> **Note:** browsers only allow microphone access on secure origins. `localhost` is exempt; testing from other devices requires HTTPS in front of the server — see PLANNING.md Phase 4 (Unraid + Pangolin).

## Phone calls via a PBX (PBXware / Asterisk)

Besides rooms, the app has a softphone at `#/phone` ("Open the phone" on the home screen): the browser registers as an extension on your PBX over SIP-over-WSS ([SIP.js](https://sipjs.com)), then dials numbers and takes calls through it. The PBX does the WebRTC↔phone-network bridging, so this path is not peer-to-peer, and our server isn't involved.

The PBX needs:

- a **WSS listener** reachable from the browser, with a certificate the browser trusts (e.g. `wss://pbx.example.com:8089/ws`)
- an **extension with WebRTC enabled** (DTLS-SRTP, ICE, AVPF, rtcp-mux — Asterisk's `webrtc=yes`), Opus and/or G.711 allowed
- its **RTP port range** open to the browser

Enter the WSS URL and the extension's username/password on the phone screen. They're saved in that browser's `localStorage` only and are never built into the image (which is public). Details and status in [PLANNING.md](PLANNING.md) Phase 5.

## Docker (single container)

```bash
docker build -t webrtc-phone .
docker run -d -p 3001:3001 webrtc-phone
```

One image: Express serves the built client and the Socket.io signaling from port 3001.

Set `TLS_CERT`/`TLS_KEY` (paths to a PEM cert/key, e.g. self-signed via openssl) to serve HTTPS instead — required for mic access from any device that isn't localhost. Plain HTTP requests to that same port are redirected to HTTPS, so a shared `host:3001` link works whichever scheme the browser guesses.

## Deploy to Unraid

```bash
bash deploy/unraid.sh <unraid-ip>
```

Builds the image locally, ships it over SSH (`docker save`/`scp`/`docker load`), and (re)starts the container. If `/mnt/user/appdata/webrtc-phone/certs/{cert,key}.pem` exist on the server, the container serves HTTPS with them. Re-run the script to deploy updates.

## Tests

With the server running (`npm run dev` in `server/`, and `npm run build` in `client/` if testing the served build):

```bash
cd server
npm run test:signaling   # scripted protocol test of the room/relay logic
npm run test:call        # full call in headless Chrome (fake mic): join, connect, mute, hang up, rejoin
npm run test:phone       # softphone against a local Asterisk (below): register, calls both ways, DTMF, busy, cancel
```

`test:phone` needs the throwaway PBX in `dev/asterisk` running first. PBXware is Asterisk underneath, so it's the same WebRTC path without touching the real PBX:

```bash
docker build -t webrtc-phone-asterisk dev/asterisk
docker run -d --rm --name webrtc-phone-asterisk --network host webrtc-phone-asterisk
```

No Chrome installed? `npx @puppeteer/browsers install chrome-headless-shell@stable` and point `CHROME_PATH` at the binary it prints (both browser tests honour it).

The rest of verification is a manual checklist (two devices, cross-network) in [PLANNING.md](PLANNING.md).

## Project docs

- [PLANNING.md](PLANNING.md) — phased plan, decisions, manual test checklist
- [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) — WebRTC explainer built around this code
- [docs/THE-STACK.md](docs/THE-STACK.md) — every layer of the system, from microphone to phone network
- `.planning/` — requirements and research (stack, architecture, features, and 12 WebRTC pitfalls)
