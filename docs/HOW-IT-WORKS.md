# How this app works

A tour of WebRTC using this codebase as the running example. Written for an engineer who has built web apps but never touched WebRTC. Code pointers reference `server/src/index.ts` and `client/src/hooks/useCall.ts`, which contain essentially all of the interesting logic.

## The problem

Two browsers want to stream audio to each other directly — not through a server, because relaying real-time media is expensive and adds latency. Two things make this hard:

1. **Browsers can't accept inbound connections.** There's no `listen()` in a browser. Both sides can only dial out.
2. **Both peers are behind NAT.** Each machine has a private address (`192.168.x.x`) that means nothing outside its own network. Neither peer knows an address the other could reach it at — and neither do they know their *own* public address.

WebRTC is the browser's built-in machinery for solving both: it punches through NAT where possible and establishes an encrypted, latency-optimized media channel directly between two machines. What WebRTC deliberately does **not** solve is how the two browsers find each other in the first place. That part is on you.

## The cast

| Piece | What it is | In this repo |
|---|---|---|
| `getUserMedia` | Browser API: prompts for mic permission, returns a `MediaStream` | `useCall.ts` |
| `RTCPeerConnection` | Browser API: the whole connection engine — negotiation, NAT traversal, encryption, codecs | `useCall.ts` |
| Signaling server | *Your* code: passes small setup messages between the two peers | `server/src/index.ts` |
| STUN server | Public internet service: tells a peer its own public IP:port | Google's, config in `client/src/config.ts` |
| TURN server | Relay of last resort when a direct path is impossible | Not deployed (see end) |

## Signaling: the bootstrapping paradox

Before the peers can talk directly, they must exchange connection details. But they can't exchange anything directly yet — that's the very connection being set up. So they need a mutually reachable middleman for the handshake. That's the **signaling server**, and it's the reason a "serverless" P2P app still has a server.

The WebRTC spec intentionally doesn't define signaling. The two peers just need *some* channel through which they can pass opaque blobs. Ours (`server/src/index.ts`) is ~100 lines of Socket.io: a `Map` of room code → socket IDs (capped at two), and relay handlers that forward two message types to the *other* socket in the room:

- `description` — SDP session descriptions (offers/answers)
- `ice-candidate` — candidate transport addresses

The server never parses any of it. It's a mail carrier, not a participant. And once the call connects, it goes idle: hang up mid-call and kill the server, and audio keeps flowing.

One server-side subtlety: relays use `socket.to(room).emit(...)` — "everyone in the room *except the sender*." Using `io.in(room).emit(...)` would echo each peer's own offer back to it, which corrupts the negotiation state machine.

## SDP: what the peers actually exchange

An **SDP** (Session Description Protocol) blob is a peer's statement of "here's what I can do and what I want": which media (one audio track here), which codecs (Opus etc.), encryption fingerprints, and transport parameters. It's a legacy line-based text format — you never build one by hand; `RTCPeerConnection` generates them.

The exchange is a fixed two-step: one side calls `createOffer()` and the other answers with `createAnswer()`. Each peer applies both descriptions — its own via `setLocalDescription()`, the remote one via `setRemoteDescription()`. Once both sides hold both descriptions, they've agreed on codecs and encryption parameters, and ICE (next section) has what it needs to start.

In this codebase you won't see explicit `createOffer()`/`createAnswer()` calls: the parameterless `setLocalDescription()` figures out which one is needed from the current state. The trigger is the `negotiationneeded` event, which the browser fires when something requires (re)negotiation — in our case, adding the mic track:

```
addTrack → onnegotiationneeded → setLocalDescription() → socket.emit('description', …)
                                        ⋮ (relayed by the server)
other peer: setRemoteDescription(offer) → setLocalDescription() → emits its answer back
```

## ICE: finding a path between two NATed machines

Agreeing on codecs is useless without a network path. **ICE** (Interactive Connectivity Establishment) finds one by brute force. Each peer gathers **candidates** — addresses where it might be reachable:

- **host** — its private LAN address (works if both peers are on the same network)
- **srflx** ("server-reflexive") — its public IP:port, learned by asking a **STUN** server "what address did this packet come from?" This works because home NATs typically keep that mapping open for return traffic — the classic "hole punch."
- **relay** — an address on a TURN server that will forward traffic (only if TURN is configured)

Candidates are sent to the peer as they're discovered (**trickle ICE** — that's the `onicecandidate → socket.emit('ice-candidate', …)` wiring), rather than waiting for the full list. Both sides then systematically probe candidate *pairs* with connectivity checks and pick the best pair that works. You can watch this play out in `chrome://webrtc-internals` (or `about:webrtc` in Firefox) — worth opening on your first real call.

Why STUN isn't always enough: **symmetric NAT** (common on corporate and some carrier networks) allocates a *different* public port per destination, so the address the STUN server observed is useless to the peer. No hole to punch → both direct routes fail → the only option is relaying through TURN. That's the ~15% failure case; this project adds TURN only if cross-network testing actually hits it (`PLANNING.md`, Phase 4).

## Encryption: free, mandatory, invisible

WebRTC requires encryption — there is no plaintext mode. After ICE picks a path, the peers run a **DTLS** handshake (TLS over UDP) directly with each other, and the resulting keys encrypt the audio as **SRTP**. The certificate fingerprints travel inside the SDP, so the signaling exchange anchors trust. This is why the app adds no crypto of its own: the transport is end-to-end encrypted by spec, and your signaling server never sees keys, only fingerprints.

## Glare, and why the code has "polite" and "impolite" peers

Both peers add their mic track as soon as they know the other is in the room, so **both fire `negotiationneeded` and send an offer at nearly the same time**. Two simultaneous offers ("glare") deadlock a naive implementation: each side is waiting for an answer while holding an incompatible incoming offer, and the connection hangs silently. This bug passes solo testing every time — it needs a near-simultaneous join to reproduce.

The standard fix is MDN's **perfect negotiation** pattern, which this app uses. Both peers run identical code, but they're assigned asymmetric roles when they join the room (`server/src/index.ts`: first joiner = **polite**):

- The **impolite** peer, on receiving an offer mid-collision, ignores it. Its own offer wins.
- The **polite** peer, on receiving an offer mid-collision, abandons its own offer (`setRemoteDescription` performs an implicit rollback) and answers the remote one.

Either way, exactly one offer survives. The collision detection is the `makingOffer` / `signalingState !== 'stable'` check in `useCall.ts`.

## Life of a call in this app

Alice opens `/#ABC123`; Bob opens the same link a moment later.

1. **Join.** Each client connects to the server via Socket.io and emits `join-room`. Alice (first in) gets `polite: true` and waits. When Bob joins, the server tells him a peer is present and tells Alice `peer-joined`.
2. **Media.** Both sides run `getUserMedia({ audio: true })` — the mic permission prompt — and add the track to a fresh `RTCPeerConnection` configured with STUN servers.
3. **Negotiate.** `addTrack` fires `negotiationneeded` on both sides; both send offers; perfect negotiation collapses that to one offer + one answer, relayed through the server.
4. **Connect.** Meanwhile both sides trickle ICE candidates through the server and probe pairs. When a pair works, DTLS handshakes over it, and `connectionState` becomes `connected`. The UI flips to "Connected."
5. **Audio flows peer-to-peer.** Each side's `track` event delivers the remote `MediaStream`, which the UI assigns to an `<audio autoplay>` element's `srcObject`. The server is no longer involved.
6. **In-call controls.** Mute just sets `track.enabled = false` on the local audio track — the track keeps running but emits silence; no renegotiation needed.
7. **Teardown.** Hang-up (or tab close, which the server treats identically via socket disconnect) notifies the other side with `peer-left`. Both ends `stop()` every track — `pc.close()` alone does *not* release the mic, and the browser's recording indicator stays on if you forget — and close the connection. The remaining peer returns to "waiting," so if their partner rejoins the same room, a brand-new negotiation reconnects the call automatically.

## Implementation notes worth stealing

**Everything long-lived lives outside React state.** The `RTCPeerConnection`, socket, streams, and negotiation flags live in the effect closure / refs in `useCall.ts`, never in `useState`. Handlers attached to a peer connection survive across renders; if they closed over state values they'd see stale snapshots (the classic React/WebRTC bug). React state holds only what the UI renders: phase, mute flag, message.

**ICE candidates are buffered.** A remote candidate can arrive (fast network, slow `getUserMedia`) before `setRemoteDescription` has been applied; calling `addIceCandidate` then throws `InvalidStateError` and the candidate is lost, degrading or breaking connectivity. Candidates that arrive early are queued and flushed right after the remote description lands.

**The secure-context guard.** `navigator.mediaDevices` literally does not exist on insecure origins — `http://192.168.1.10:3001` gets `undefined`, not a permission error. Localhost is exempt, which is why everything works in dev and then "breaks on the LAN." Cross-device testing requires HTTPS in front of the server (for this project: Pangolin, later). The app checks `window.isSecureContext` and says so instead of crashing.

**Roles are maintained across peer churn.** When a peer leaves, the survivor self-promotes to polite (it's now effectively the first one in the room), so the next joiner's impolite role stays consistent and a rejoin can't produce two impolite peers — which would make glare unresolvable.

## Verifying it

- `server/scripts/signaling-test.mjs` — protocol-level test of the room/relay logic with scripted socket clients (no browser).
- `server/scripts/call-test.mjs` — full end-to-end call in headless Chrome using fake media devices: two tabs join, reach `connected` (real SDP/ICE/DTLS), exchange a remote track, mute, hang up, and reconnect.
- Manually: `chrome://webrtc-internals` while on a call shows the live ICE candidate grid, selected pair, and per-second stats — the single most useful WebRTC debugging tool.
