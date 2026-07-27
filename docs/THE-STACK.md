# The stack, end to end

Written for an engineer who is comfortable with web systems — HTTP, TLS, containers, CI — but has never shipped anything real-time. It walks every layer of this project, from the microphone driver to the phone network, and explains what each layer is actually responsible for and how it fails.

This is the *system* view. Its companion, [HOW-IT-WORKS.md](HOW-IT-WORKS.md), is the *protocol* view: a close reading of signaling, SDP, ICE and perfect negotiation against `useCall.ts`. Read that one to understand WebRTC; read this one to understand the deployment you are on call for.

---

## The one idea that explains everything else

A real-time system has **two independent planes**. Almost every surprising thing in this project follows from the fact that they are separate.

| | Signaling plane | Media plane |
|---|---|---|
| Carries | "here's my SDP", "here's a candidate", room membership | the audio itself |
| Transport | TCP — WebSocket via Socket.io, over TLS | UDP — SRTP, encrypted end to end |
| Who's involved | your server, plus any proxy in front of it | the two endpoints, and a TURN relay only if direct fails |
| Path | browser → your Unraid box → other browser | browser → other browser, directly |
| Standardized? | **No.** You invent it | Yes, rigidly — ICE, DTLS, SRTP, RTP |
| If it dies mid-call | nothing happens; audio keeps flowing | call is over |
| Debug with | server logs, browser network tab | `chrome://webrtc-internals`, `getStats()` |

Consequences worth internalizing:

- **Your signaling server is not on the audio path.** It sees kilobytes per call, total. It could be a Raspberry Pi.
- **A reverse proxy in front of your app never touches the media.** Pangolin will carry signaling and the web assets; the audio bypasses it entirely and goes browser-to-browser. Its bandwidth is irrelevant to call quality.
- **"Connected" is two different questions.** The socket can be up while the peer connection is failing, and vice versa. The UI must not conflate them.
- **Killing the server mid-call does nothing.** Try it — it's the fastest way to make this real.

---

## The system today

```
                  ┌──────────────────────────────────────────┐
   signaling      │  Unraid (192.168.1.202) — Docker         │
   (TCP/WSS) ────▶│  ghcr.io/oabaig/web-rtc-phone            │
                  │  Express ─ static client/dist            │
                  │          └ Socket.io ─ rooms + relay     │
                  └──────────────────────────────────────────┘
                        ▲                          ▲
                        │ TLS                      │
                  ┌─────┴─────┐              ┌─────┴─────┐
                  │ Browser A │              │ Browser B │
                  └─────┬─────┘              └─────┬─────┘
                        │                          │
                        └──── audio: SRTP/UDP ─────┘
                             direct, after ICE
                                   ▲
                                   └── STUN (stun.l.google.com) consulted
                                       during setup only, never for media
```

Phase 5 adds one box — a media gateway on the DigitalOcean droplet — and for *those* calls the direct arrow disappears: audio runs browser → gateway → carrier.

---

## Layer 1 — The browser as a media device

Before any networking, the browser has to hand you audio. Three APIs and a permissions model:

- **`getUserMedia({audio:true})`** prompts the user and resolves to a **`MediaStream`** — a container of **`MediaStreamTrack`s**. One mic = one audio track.
- **A track is a live handle to hardware.** `track.enabled = false` (our mute) keeps the mic open and transmits silence — no renegotiation, instant, and the OS recording indicator stays on. `track.stop()` releases the device. `pc.close()` does *not* stop tracks; forget this and the browser tab keeps the mic hot after the call ends (`useCall.ts:62-71`).
- **Playback fights autoplay policy.** Assigning `srcObject` and calling `play()` can reject until a user gesture happens. We swallow that rejection deliberately (`useCall.ts:104`); in a product you'd surface an "unmute" affordance.

The rule that trips up every newcomer: **`navigator.mediaDevices` does not exist on an insecure origin.** Not "throws" — `undefined`. `localhost` is exempt, which is why everything works in development and breaks the instant you share a LAN IP. That single rule is why this project has TLS certs, a redirect, and a Pangolin phase (Layer 5).

## Layer 2 — The client application

React 18 + Vite + TypeScript. All the interesting code is one hook, `client/src/hooks/useCall.ts`; components render state and never see an `RTCPeerConnection`.

| Concern | Where | Why there |
|---|---|---|
| Peer connection, socket, streams, negotiation flags | effect closure / `useRef` | Long-lived and imperative. Handlers attached to a peer connection outlive renders — if they closed over `useState` values they'd read stale snapshots |
| Phase, mute flag, error message | `useReducer` | It's a finite state machine (`idle → joining → waiting → connecting → connected → ended`), and only these drive rendering |
| Room code | URL hash | Makes the link shareable with zero backend state |

**The generalizable lesson:** WebRTC is an imperative, event-driven state machine with a lifetime longer than any render. React state is a cache for rendering. Mixing the two — putting the peer connection in `useState`, or reading state inside a long-lived event handler — is the single most common way React WebRTC apps break, and it breaks *intermittently*, which is worse.

## Layer 3 — Signaling: the part you have to write

The WebRTC spec defines how two peers connect but deliberately refuses to define how they *find* each other. So every WebRTC app contains a bespoke signaling service, and this is where your design decisions actually live.

The requirements are modest: a mutually reachable channel that is ordered, reliable and reasonably prompt, over which you can pass opaque blobs and know who the other party is. WebSocket is the obvious fit. It could equally be HTTP polling, MQTT, or — genuinely — a QR code you photograph, if you're willing to give up trickle ICE.

Ours is about a hundred lines of Socket.io (`server/src/index.ts`):

| Event | Direction | Payload |
|---|---|---|
| `join-room` | client → server | room code |
| `room-joined` | server → client | `{ polite, peerPresent }` — the perfect-negotiation role, assigned server-side at join |
| `peer-joined` / `peer-left` | server → client | — |
| `description` | relayed | an SDP offer *or* answer, opaque to the server |
| `ice-candidate` | relayed | one candidate, opaque to the server |
| `room-full` / `join-error` | server → client | rejection reason |

Three things worth stealing:

1. **The server never parses SDP.** It's a mail carrier. That keeps it protocol-version-proof — add video tomorrow and the server doesn't change.
2. **Relay with `socket.to(room)`, never `io.in(room)`.** The latter echoes a peer's own offer back to it and corrupts the negotiation state machine — a bug that looks like a WebRTC problem and isn't.
3. **Asymmetric roles are assigned by the server**, because it is the only party that knows who arrived first. That's the seed for glare resolution (see HOW-IT-WORKS.md).

Operationally this layer is nearly free: a room is a `Map` entry, a call is a few dozen small messages. State is intentionally in memory — rooms are ephemeral, and a restart just makes everyone reconnect. The moment you want persistence or multiple server instances, you need a shared room registry (Redis adapter) — not because of load, but because two peers must land on the *same* instance.

## Layer 4 — The media path

This is the layer that is genuinely unlike anything in a CRUD stack.

**ICE — finding a route.** Each peer gathers *candidates*, meaning "addresses I might be reachable at":

| Type | Origin | Works when |
|---|---|---|
| `host` | local NIC address | same LAN (or same machine) |
| `srflx` | your public IP:port, as observed by a **STUN** server | typical home NAT, both sides — the hole punch |
| `prflx` | discovered during connectivity checks | NAT rewrote the port mid-negotiation |
| `relay` | allocated on a **TURN** server | everything else — nothing direct works |

Candidates are exchanged as they're found (*trickle ICE*), then both sides probe pairs and settle on one. Two details that cost people days:

- **Chrome hides private IPs behind `.local` mDNS names** until the page holds mic permission. A permissionless demo therefore gathers different candidates than this app does.
- **A VPN on either peer usually breaks LAN calls.** The tunnel's interface produces candidates that the other peer can't reach, and the provider blocks inbound UDP. We hit exactly this during Phase 4 LAN testing with ProtonVPN active — the symptom is ICE `failed` with signaling working perfectly, because signaling is TCP through the tunnel and media is not.

STUN is a *question*, not a proxy: "what source address did this packet arrive from?" It carries no media and costs nothing. TURN is a real relay — it forwards every packet of the call, so it costs bandwidth and money, and it's needed for the minority of networks (symmetric NAT, strict corporate firewalls) where no direct path exists. Industry figures put that at roughly 10–20% of calls in the wild. This project adds TURN only when testing proves it necessary; premature TURN silently routes everything through a relay and hides the NAT problems you were trying to learn about.

**DTLS-SRTP — encryption you don't configure.** Once a candidate pair works, the peers run a DTLS handshake *directly with each other* and derive SRTP keys from it. The certificate fingerprints ride inside the SDP, so the signaling channel is what anchors trust — which is why signaling must be authenticated in a real product, even though it never sees a key. There is no unencrypted mode in WebRTC. You get end-to-end encryption for 1:1 calls for free, and you lose it the moment a gateway or SFU terminates the media (as Phase 5 does).

**Codec and resilience.** Audio is Opus at 48 kHz, roughly 24–40 kbps for mono speech. Real-time media over UDP means loss is normal and retransmission is often worse than useless, so the stack leans on a jitter buffer, packet-loss concealment, and selective retransmission (NACK) instead of TCP-style reliability. This is why a call degrades gracefully instead of stalling — and why you must never "fix" WebRTC by putting media over TCP.

**Numbers to keep in your head:**

| Quantity | Value |
|---|---|
| Audio bandwidth, 1:1 | ~25–40 kbps each way (Opus) |
| Signaling per call | a few KB, total |
| Ports used for media | one UDP port per peer (rtcp-mux), ephemeral |
| Setup latency, LAN | tens of ms; cross-internet with STUN, typically < 1 s |
| Server bandwidth per call | **zero**, unless TURN is in the path |

**`connectionState` vs `iceConnectionState`.** The former aggregates ICE *and* DTLS and is what the UI should watch (`useCall.ts:110`). `disconnected` is frequently transient — a network blip that ICE recovers from — which is why the app shows "connecting" rather than declaring failure. `failed` is terminal without an ICE restart.

## Layer 5 — Origin, TLS, and the edge

Three constraints collide here, and the solutions in this repo are all consequences:

1. **Mic access requires a secure context** — so anything not on `localhost` needs real HTTPS.
2. **Socket.io needs its WebSocket upgrade to survive** whatever sits in front of the app — any proxy must pass `Upgrade`/`Connection` headers (Pangolin does by default).
3. **Client and signaling share one origin** — Express serves `client/dist` and Socket.io from the same port (`server/src/index.ts:111-121`), so there's no CORS story and no second deployment in production. In development they're split (Vite on 5173, server on 3001), which is what `client/src/config.ts` switches on.

Two implementation details worth knowing about:

- **Optional TLS in the app itself.** `TLS_CERT`/`TLS_KEY` make the server serve HTTPS directly, with a self-signed cert for LAN testing. Unset, it's plain HTTP for running behind a proxy that terminates TLS. One image covers both deployments.
- **Same-port scheme redirect.** Browsers default a bare `host:3001` to `http://`, and a plaintext request to a TLS socket dies with an empty response — a genuinely confusing failure. So when TLS is on, the listener sniffs the first byte of each connection (`0x16` is a TLS handshake record) and hands plaintext connections to a 301 redirector instead (`server/src/index.ts:125-154`). One port, both schemes.

Behind Pangolin the picture simplifies: Pangolin terminates TLS with a real certificate on a real hostname, the container reverts to plain HTTP, and the self-signed warnings disappear. Remember that this fixes *signaling and page load only* — the media still leaves your network directly, so the tunnel is not a bottleneck and also not a fix for NAT problems.

## Layer 6 — Packaging and delivery

| Stage | Mechanism |
|---|---|
| Build | Multi-stage `Dockerfile`: client build → server build → slim runtime carrying only `dist` + production `node_modules`, running as `USER node` |
| CI | `.github/workflows/build.yml` — every push to `main` builds and pushes `ghcr.io/oabaig/web-rtc-phone`, tagged `latest` and `sha-<short>` for rollback |
| Registry | GHCR, package public so Unraid can pull anonymously (the repo's visibility is a separate setting) |
| Deploy | Unraid Docker tab pulls the new image; `deploy/unraid.sh` remains an offline fallback that ships an image over SSH |
| Config surface | `PORT`, `TLS_CERT`, `TLS_KEY` — that's the entire contract |

The whole loop is: `git push` → ~2 min of CI → pull on Unraid. Nothing about the app is built on the server, and the image that passed CI is the exact image that runs.

## Layer 7 — Telephony: WebRTC meets the phone network

Phase 5's territory. The two worlds solve the same problem and agree on almost nothing:

| | Browser (WebRTC) | SIP trunk (VoIP Innovations) |
|---|---|---|
| Signaling | your Socket.io messages, or SIP over WSS | SIP over UDP/TCP/TLS, ports 5060/5061 |
| Media transport | SRTP, keyed by DTLS | plain RTP, usually unencrypted |
| Path discovery | ICE, mandatory | none — fixed IP:port, and NAT is your problem |
| Codec | Opus 48 kHz | G.711 μ-law 8 kHz |
| Identity | a room code you invented | E.164 numbers, and a carrier who bills you |

Bridging those requires a **B2BUA** — a back-to-back user agent, i.e. a box that terminates one call leg and originates another, with full control of both. Asterisk or FreeSWITCH. It terminates ICE and DTLS toward the browser, decrypts SRTP to RTP, transcodes Opus to μ-law, and speaks SIP to the carrier.

**SIP in ninety seconds**, for someone who already knows WebRTC: it's a text request/response protocol that looks like HTTP (`INVITE`, `200 OK`, `ACK`, `BYE`, `REGISTER`) and — here's the useful part — **it carries the same SDP you already understand** as its body. Offer/answer is literally the same RFC 3264 exchange, just wrapped in SIP messages instead of your `description` event. What's new is not the negotiation model; it's registration, dialplans, and the fact that the other party is a phone company.

Consequences that matter more than the plumbing:

- **The call is no longer end-to-end encrypted, and no longer peer-to-peer.** The gateway holds plaintext audio by definition. That's inherent to touching the PSTN, not a shortcut.
- **Money is now attached to your ports.** An exposed SIP port is scanned within minutes; a compromised endpoint places international calls billed to you. Allowlist carrier IPs, refuse anonymous SIP, cap concurrent channels, and set spend alerts *before* the trunk is live.
- **Trunks authenticate by IP**, so the gateway belongs somewhere with a static address — the DigitalOcean droplet, not home broadband behind a tunnel.
- **DTMF is not audio.** Dialpad tones travel as RFC 4733 `telephone-event` packets (`RTCDTMFSender.insertDTMF()`); IVRs will not hear tones you play into the mic.
- **Your number has a reputation.** Carrier STIR/SHAKEN attestation and CNAM decide whether the callee sees your name or "Spam Likely".
- **E911** is a legal obligation on a real DID, not an optional feature.

## Debugging: symptom → cause → tool

| Symptom | Usual cause | Where to look |
|---|---|---|
| "needs a secure origin" / `mediaDevices` undefined | insecure origin — the LAN IP case | Layer 1; use HTTPS or `localhost` |
| Works on localhost, fails between two machines | same as above, or ICE | `chrome://webrtc-internals` → candidate grid |
| ICE stuck in `checking`, then `failed` | VPN on a peer, symmetric NAT, UDP blocked | webrtc-internals: are there `srflx` candidates at all? Disconnect the VPN first — that's the highest-yield single test |
| Connected, but no audio | track never attached, autoplay blocked, or the peer is muted | `ontrack` fired? `audio.srcObject` set? `getStats()` → `inbound-rtp.packetsReceived` climbing? |
| Call connects, dies ~30 s later | ICE consent checks (RFC 7675) stopped getting through | webrtc-internals timeline; a stateful firewall dropping the UDP flow |
| Both sides hang in "connecting" forever | glare — two simultaneous offers, no polite/impolite handling | server logs: two `description` events, no answer |
| Signaling fine, media dead | you're looking at the wrong plane | remember the table at the top |
| (P5) One-way audio on a phone call | classic SIP/NAT: gateway advertising a private address | `external_media_address`; `sngrep` on the gateway to read the SDP it sent |

`chrome://webrtc-internals` (or `about:webrtc` in Firefox) during a live call is the single highest-value tool here: candidate pairs, the selected pair, per-second bitrate and loss, and the full event timeline. Learn it before you learn anything else.

## Where this design stops working

| Change | What breaks | The fix |
|---|---|---|
| 3+ people in a call | Mesh P2P needs n−1 uploads per peer; a 5-way call is 4 encoder streams per browser | An **SFU** (mediasoup, Janus, LiveKit) — media stops being P2P |
| Restrictive networks | ~10–20% of calls can't find a direct path | TURN, ideally over TCP/443 too; it costs relay bandwidth |
| Multiple server instances | Two peers land on different instances and never meet | Socket.io Redis adapter, or sticky room→instance routing |
| Recording or transcription | There's no media at the server to record | Either an SFU/gateway in the path, or client-side `MediaRecorder` |
| PSTN | Phones don't speak WebRTC | Phase 5's gateway |

Notice the pattern: nearly every requirement past "two browsers talking" is paid for by putting a server back on the media path. The peer-to-peer property is what makes this app nearly free to run, and it's the first thing you spend.

## Glossary

| Term | Meaning |
|---|---|
| **SDP** | Session Description Protocol — the text blob describing codecs, transport and crypto fingerprints |
| **Offer / answer** | The two-message negotiation (RFC 3264) both WebRTC and SIP use |
| **ICE** | Interactive Connectivity Establishment — the candidate-gathering and probing algorithm that finds a path |
| **STUN** | Server that reports your public IP:port. Setup only, no media |
| **TURN** | Relay that forwards media when no direct path exists |
| **Trickle ICE** | Sending candidates as discovered instead of waiting for the full set |
| **DTLS-SRTP** | DTLS handshake between peers; its keys encrypt the RTP media (RFC 5764) |
| **RTP / RTCP** | Real-time transport for media / its control and statistics channel |
| **rtcp-mux** | Media and control on one port — why a call needs one UDP port, not two |
| **Glare** | Both peers offering at once; resolved by perfect negotiation's polite/impolite roles |
| **Jitter buffer** | Small playout delay absorbing variable arrival times |
| **SFU / MCU** | Selective Forwarding Unit (forwards streams) / Multipoint Control Unit (mixes them) — multi-party topologies |
| **SIP** | Session Initiation Protocol — telephony signaling; carries SDP |
| **B2BUA** | Back-to-back user agent: terminates one call leg, originates another (Asterisk here) |
| **SIP trunk** | A carrier connection carrying calls to/from the PSTN |
| **DID** | Direct Inward Dial — a phone number that routes to you |
| **E.164** | The international number format (`+15551234567`) |
| **DTMF** | Dialpad tones; on the wire as RFC 4733 events, not audio |
| **PSTN** | The public switched telephone network |
| **STIR/SHAKEN** | Caller-ID attestation framework; decides whether you look like spam |

## Further reading

- [MDN: Perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation) — the pattern this app implements
- [WebRTC for the Curious](https://webrtcforthecurious.com/) — vendor-neutral, protocol-level, free
- RFCs when you need ground truth: 8445 (ICE), 3264 (offer/answer), 5764 (DTLS-SRTP), 3550 (RTP), 3261 (SIP), 4733 (DTMF)
- [Asterisk WebRTC configuration](https://docs.asterisk.org/Configuration/WebRTC/) — for Phase 5
