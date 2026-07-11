# WebRTC Phone — Project Plan

A browser-based audio calling app: two people open the same room link and talk in real time, peer-to-peer, with no accounts or plugins. This is a **learning project** — the point is to understand WebRTC end-to-end, so implementation choices favor clarity over abstraction (no PeerJS, no Twilio).

Companion documents (in `.planning/`):

- [`PROJECT.md`](.planning/PROJECT.md) — requirements and scope boundaries
- [`research/STACK.md`](.planning/research/STACK.md) — full stack rationale and versions
- [`research/ARCHITECTURE.md`](.planning/research/ARCHITECTURE.md) — signaling sequence and component boundaries
- [`research/FEATURES.md`](.planning/research/FEATURES.md) — feature landscape (table stakes / differentiators / anti-features)
- [`research/PITFALLS.md`](.planning/research/PITFALLS.md) — 12 known WebRTC pitfalls with prevention code

---

## Decisions (2026-07-06)

| Decision | Choice | Notes |
|----------|--------|-------|
| Scope | 1:1 **audio-only** rooms, browser-to-browser | No video, no PSTN/phone numbers, no multi-party |
| Repo layout | Monorepo: `client/` + `server/` | Two packages, one repo; can still ship as one Docker image |
| Environment | **Localhost first** | Cross-device/HTTPS deferred until the app works locally |
| Test hosting (later) | Unraid server (R7920) via Docker | Both pieces in one container |
| Internet exposure (later) | Pangolin (already running on DigitalOcean) | Also solves the HTTPS requirement for mic access |
| Testing rigor | Manual test checklist per phase | Audio/ICE flow isn't meaningfully unit-testable |

## Stack (summary)

- **Client:** React 18 + Vite + TypeScript, `socket.io-client`, `webrtc-adapter`
- **Server:** Node 20 LTS, Express, Socket.io 4.x
- **ICE:** Google public STUN (`stun.l.google.com:19302`); TURN only if cross-network testing fails
- **State:** `useReducer` + `useRef` inside a single `useCall` hook — no state library

See [`research/STACK.md`](.planning/research/STACK.md) for versions, rationale, and the "what NOT to use" list.

## Architecture (summary)

```
┌──────────┐   Socket.io (signaling only)   ┌──────────┐
│ Browser A │◄──────────┐      ┌───────────►│ Browser B │
└─────┬────┘      ┌─────┴──────┴─────┐      └─────┬────┘
      │           │ Node signaling    │            │
      │           │ server (rooms +   │            │
      │           │ SDP/ICE relay)    │            │
      │           └──────────────────┘             │
      │                                            │
      └────────── audio: peer-to-peer ─────────────┘
              (DTLS-SRTP, via STUN-discovered path)
```

The server only participates in the handshake. Room registry is an in-memory `Map` capped at 2 sockets per room; rooms are ephemeral (deleted on disconnect). Full signaling sequence in [`research/ARCHITECTURE.md`](.planning/research/ARCHITECTURE.md).

## Repo layout

```
web-rtc-phone/
├── client/            # React + Vite + TS app
│   └── src/
│       ├── hooks/     # useCall — all WebRTC + socket logic lives here
│       └── components/
├── server/            # Node + Express + Socket.io signaling server
│   └── src/
├── .planning/         # Project docs and research
├── PLANNING.md        # This file
└── README.md
```

---

## Phases

### Phase 0 — Scaffolding ✅ (2026-07-06)

**Goal:** Both packages run and talk to each other (a socket connects), nothing more.

- [x] `client/`: `npm create vite@latest client -- --template react-ts`; add `socket.io-client`, `webrtc-adapter`
- [x] `server/`: Node + Express + Socket.io + TypeScript, `tsx watch` dev script
- [x] Client connects to server socket; log connect/disconnect on both ends
- [x] Root README quick-start works from a fresh clone

**Done when:** `npm run dev` in both folders; browser console shows a socket connection.

### Phase 1 — Signaling server ✅ (2026-07-06)

**Goal:** Complete room + relay protocol, verifiable without WebRTC.

- [x] Events: `join-room`, `room-joined`, `peer-joined`, `description`, `ice-candidate`, `leave`, `peer-left` (offer/answer merged into one `description` event — perfect negotiation handles both through the same path)
- [x] In-memory room map; cap at 2 sockets, reject a third (`room-full`)
- [x] Relay with `socket.to(room).emit(...)` — **never** `io.in(room).emit(...)` (echoes to sender — Pitfall 10)
- [x] Assign polite/impolite roles at join time (first joiner = polite) for Perfect Negotiation
- [x] Cleanup on `disconnect`: delete room, notify remaining peer

**Done when:** verified by `server/scripts/signaling-test.mjs` — 10 scripted protocol checks including no-echo and room-full.

### Phase 2 — Media + peer connection (the core) ✅ (2026-07-06)

**Goal:** Live bidirectional audio between two tabs on localhost.

- [x] `getUserMedia({ audio: true })` with `NotAllowedError` / `NotFoundError` handling
- [x] `RTCPeerConnection` with STUN config; `addTrack` fires `negotiationneeded` (Pitfall: track-before-offer ordering)
- [x] Perfect Negotiation pattern (polite/impolite) instead of naive caller/callee (Pitfall 2)
- [x] ICE candidate buffer: queue candidates until `setRemoteDescription` resolves (Pitfall 1)
- [x] `ontrack` → `<audio autoplay>` with `e.streams[0] ?? new MediaStream([e.track])` fallback (Pitfall 8)
- [x] All connection objects in refs/effect closure, never `useState` (Pitfall 5)
- [x] Full teardown: `track.stop()` on every track + `pc.close()` + null refs (Pitfall 6 — mic indicator must turn off)

**Done when:** verified by `server/scripts/call-test.mjs` — real call in headless Chrome with fake mic devices.

### Phase 3 — Call UI ✅ (2026-07-06)

**Goal:** Usable app instead of console-driven demo.

- [x] Home screen: create room (generated short code) or join by code; room code in URL hash so links are shareable
- [x] Call screen: status (`connecting` → `connected` → `ended`), mute/unmute (`track.enabled`), hang up
- [x] "Peer left" returns survivor to *waiting* (call auto-recovers if the peer rejoins); ICE `failed` shows an error instead of spinning forever (Pitfall 9)
- [x] Copy-room-link button (`navigator.clipboard`)

**Done when:** e2e test passes: join, connect, mute, hang up, peer-left notice, rejoin+reconnect.

### Phase 4 — Cross-device testing + Unraid deployment (in progress)

**Goal:** A real call between two devices on different networks.

- [x] Dockerfile: multi-stage build — build client, serve `client/dist` + Socket.io from the one Express server (image builds; e2e test passes against the running container)
- [x] Add `isSecureContext` guard with a clear error message (Pitfall 3)
- [x] Deploy container to Unraid (R7920) — `deploy/unraid.sh`, serving `https://192.168.1.202:3001` with a self-signed cert (2026-07-11)
- [ ] Expose via Pangolin (DigitalOcean) → provides the **HTTPS** origin required for `getUserMedia` off-localhost
- [ ] Test: two devices, different networks (e.g. laptop on Wi-Fi + phone on mobile data)
- [ ] If ICE sticks at `checking`/`failed` cross-network: add TURN (Metered.ca free tier or self-hosted coturn on Unraid) — **not before** (Pitfall 4)

**Done when:** phone on cellular and laptop on home Wi-Fi complete a call via the Pangolin URL.

### Phase 5 — Stretch (optional, in order of learning value)

1. Speaking indicator — Web Audio `AnalyserNode`
2. Connection quality indicator — `getStats()` polling (RTT, packet loss)
3. Mic device selector — `enumerateDevices` + `replaceTrack`
4. DataChannel text chat — the other major WebRTC primitive
5. ICE restart / reconnect on failure

---

## Manual test checklist

Run at the end of Phases 3 and 4 (Phase 4 = two real devices, different networks).

| # | Test | Expected |
|---|------|----------|
| 1 | Create room | Room code shown, shareable URL in address bar |
| 2 | Join with valid code (2nd tab/device) | Both sides move to `connecting`, then `connected` |
| 3 | Join with bogus code | Clear error, no crash |
| 4 | Third participant tries to join | Rejected with message; call unaffected |
| 5 | Speak on A | Heard on B (and vice versa) |
| 6 | Mute A | B hears silence; A's UI shows muted; unmute restores audio |
| 7 | Hang up on A | B sees "peer left"; both mic indicators turn off |
| 8 | Close tab on B (no hang-up) | A notified within a few seconds; A's cleanup runs |
| 9 | Deny mic permission | Actionable error message, not a blank screen |
| 10 | Refresh mid-call | Old call cleaned up; can rejoin the room |
| 11 | Both users join simultaneously | Connects (Perfect Negotiation handles glare) |
| 12 | (Phase 4) Cross-network call | Connects via STUN; if not, TURN task triggers |

## Risks

| Risk | Mitigation |
|------|------------|
| Works on localhost, fails cross-device | Phase 4 exists for exactly this; all localhost tests skip NAT (Pitfall 12) |
| Signaling races (ICE-before-SDP, glare) | Candidate buffer + Perfect Negotiation designed in from Phase 2, not patched later |
| HTTPS forgotten until deploy day | Pangolin provides TLS; `isSecureContext` guard gives a clear error |
| Scope creep | `PROJECT.md` Out of Scope list is binding; stretch items live in Phase 5 only |
