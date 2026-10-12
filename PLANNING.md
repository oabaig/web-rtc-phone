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
| Scope | 1:1 **audio-only** rooms, browser-to-browser | No video, no multi-party. PSTN deferred to keep the core WebRTC path unobscured — un-deferred as Phase 5 (2026-07-27) |
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

### Phase 5 — Real phone numbers (PSTN via the PBXware PBX)

**Goal:** Dial an ordinary phone number from the browser, and answer calls to an existing PBX extension/DID.

The "no PSTN" line in the decisions table kept Phases 0–4 focused on raw WebRTC; it was a starting boundary, not a permanent one. This is the first phase that gives up the peer-to-peer property: a phone can't speak WebRTC, so every PSTN call runs through a media gateway that terminates ICE/DTLS on the browser side and speaks SIP + plain RTP to the carrier.

**Revised 2026-10-11:** the original plan was to build that gateway — Asterisk on the DigitalOcean droplet, with a VoIP Innovations trunk. An existing **PBXware 8 (Multi-Tenant)** server already is one: Asterisk 18 behind Bicom's SIP proxy, with trunks, DIDs, dial plans and fraud protection already in place. So the browser registers to PBXware as an ordinary extension instead, and there is no gateway of our own to run.

```
Browser ──SIP over WSS + WebRTC (DTLS-SRTP / Opus)──▶ PBXware ──SIP + RTP──▶ its trunks ──▶ PSTN
                                                        └──▶ other extensions on the PBX
```

Browser-to-browser rooms keep working untouched — the phone is a second, parallel call path (`#/phone`), not a replacement. Full background in [docs/THE-STACK.md](docs/THE-STACK.md#layer-7--telephony-webrtc-meets-the-phone-network).

**Design decisions:**

| Decision | Choice | Why |
|----------|--------|-----|
| Gateway | **The existing PBXware server** | Already terminates WebRTC (it's Asterisk underneath), already has trunks, DIDs and a static public IP. Nothing new to host or harden |
| Browser SIP leg | **SIP.js over WSS**, browser registers as a PBX extension | The PSTN leg needs real SIP (`REGISTER`/`INVITE`/`BYE`); our Socket.io protocol can't express it. `useCall` stays as-is for room calls; the phone is `usePhone` |
| Credentials | **Entered in the browser, kept in `localStorage`** | The GHCR image is public and the app has no login: credentials baked into the build or served by our server would be handed to every visitor |
| Our server | **Not involved** | The browser talks to the PBX directly over WSS; the signaling server and Docker image are unchanged |
| Codec | **Whatever the extension allows** — Opus preferred, PBX transcodes to the trunk | Forcing G.711 end-to-end avoids transcoding but locks the browser to narrowband |
| Bundle | **Phone screen lazy-loaded** | SIP.js is ~230 kB; room calls never download it |

**Tasks — app side (done 2026-10-11; verified against a local Asterisk, not yet against the real PBX):**

- [x] `usePhone` hook: register over WSS, outbound `Inviter` (with early media for carrier ringback), inbound `Invitation` with answer/decline, cancel/hang-up, mute, busy-reject a second call
- [x] Dialpad + in-call DTMF (`RTCDTMFSender` → RFC 4733 `telephone-event`, via SIP.js `sendDtmf`)
- [x] Settings form (WSS URL, username, password, optional domain/display name) and Reconnect
- [x] Incoming-call ring (Web Audio) + tab-title alert
- [x] `npm run test:phone`: headless Chrome against a throwaway Asterisk (`dev/asterisk`) — registration (incl. wrong password), audio both ways via `getStats()`, mute, DTMF, far-end hang-up, busy, cancel, incoming answer/decline/missed, un-register on tab close. Caught one bug: SIP.js's `sendDtmf()` replaces queued tones, so a fast-typed PIN lost digits (`1234` arrived as `14`)

**Tasks — PBX side (in the PBXware admin):**

- [ ] Find or enable the WebRTC **WSS listener** and note its URL (host, port, path). As of 2026-10-11 nothing answers on the usual Asterisk WSS ports, so it's off or firewalled; only 443 (web UI) and 5060/tcp respond
- [ ] Open that port in the PBX firewall, plus the RTP range, to wherever the browser runs
- [ ] Create (or pick) an extension for the browser with WebRTC enabled (DTLS-SRTP, ICE, AVPF, rtcp-mux — Asterisk's `webrtc=yes` bundle) and Opus + G.711 allowed
- [ ] Confirm the extension's outbound route/permissions and a DID or ring group that rings it
- [ ] Caller ID, E911 and STIR/SHAKEN for that extension's outbound calls (owned by the PBX config, not this app)

**Done when:** the browser places a call to a mobile phone and both sides hear each other; a call to the extension's DID rings the browser and connects; hanging up from either end tears down the other cleanly.

### Phase 6 — Stretch (optional, in order of learning value)

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
| 13 | (Phase 5) Browser → mobile phone | Phone rings, both sides hear each other |
| 14 | (Phase 5) Mobile → DID | Browser shows an incoming call; accepting connects audio |
| 15 | (Phase 5) DTMF into an IVR | Menu responds to the dialpad (RFC 4733, not audio tones) |
| 16 | (Phase 5) Hang up from the phone side | Browser returns to idle; PBX channel freed (PBXware Monitor / `core show channels` empty) |
| 17 | (Phase 5) Call while a room call is active | Paths stay independent; neither drops the other |

## Risks

| Risk | Mitigation |
|------|------------|
| Works on localhost, fails cross-device | Phase 4 exists for exactly this; all localhost tests skip NAT (Pitfall 12) |
| Signaling races (ICE-before-SDP, glare) | Candidate buffer + Perfect Negotiation designed in from Phase 2, not patched later |
| HTTPS forgotten until deploy day | Pangolin provides TLS; `isSecureContext` guard gives a clear error |
| Scope creep | `PROJECT.md` Out of Scope list is binding; stretch items live in Phase 6 only |
| (P5) Toll fraud — a leaked extension password places calls billed to the PBX | Credentials never ship with the app (entered per browser); give the browser extension a strong secret and only the outbound permissions it needs; PBXware's own intrusion protection covers the SIP ports |
| (P5) One-way audio — the classic SIP/NAT symptom | PBX on a public IP with its RTP range open; browser side is ICE + STUN, so a missing RTP firewall rule is the usual culprit |
| (P5) Calls labelled "Spam Likely" by carriers | Register CNAM and check the STIR/SHAKEN attestation level the trunk gives outbound calls |
| (P5) Media now flows through a server we operate | Accepted deliberately and only for PSTN calls — browser-to-browser stays peer-to-peer |
