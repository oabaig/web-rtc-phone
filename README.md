# WebRTC Phone

A browser-based 1:1 audio calling app. Two people open the same room link and talk in real time — peer-to-peer via WebRTC, no accounts, no plugins. A personal learning project for understanding WebRTC end-to-end (raw browser APIs, no PeerJS/Twilio abstractions).

## How it works

- **`client/`** — React + Vite + TypeScript app. Captures the mic (`getUserMedia`), manages the `RTCPeerConnection`, renders the call UI.
- **`server/`** — Node + Express + Socket.io signaling server. Holds the room registry and relays SDP offers/answers and ICE candidates during the handshake. Once connected, audio flows directly between the two browsers and the server sits idle.

## Status

Planning. See [PLANNING.md](PLANNING.md) for the phased plan, and `.planning/` for requirements and research (stack, architecture, feature scope, and 12 known WebRTC pitfalls with prevention code).

## Quick start (once Phase 0 lands)

```bash
# Terminal 1 — signaling server
cd server && npm install && npm run dev

# Terminal 2 — client
cd client && npm install && npm run dev
```

Open the client URL in two browser tabs, create a room in one, join with the code in the other.

> **Note:** browsers only allow microphone access on secure origins. `localhost` is exempt; testing from other devices requires HTTPS (planned via Docker on Unraid behind Pangolin — see PLANNING.md Phase 4).
