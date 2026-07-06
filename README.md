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

## Docker (single container)

```bash
docker build -t webrtc-phone .
docker run -d -p 3001:3001 webrtc-phone
```

One image: Express serves the built client and the Socket.io signaling from port 3001.

## Tests

With the server running (`npm run dev` in `server/`, and `npm run build` in `client/` if testing the served build):

```bash
cd server
npm run test:signaling   # scripted protocol test of the room/relay logic
npm run test:call        # full call in headless Chrome (fake mic): join, connect, mute, hang up, rejoin
```

The rest of verification is a manual checklist (two devices, cross-network) in [PLANNING.md](PLANNING.md).

## Project docs

- [PLANNING.md](PLANNING.md) — phased plan, decisions, manual test checklist
- [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) — WebRTC explainer built around this code
- `.planning/` — requirements and research (stack, architecture, features, and 12 WebRTC pitfalls)
