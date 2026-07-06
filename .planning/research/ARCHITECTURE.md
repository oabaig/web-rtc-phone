# Architecture

**Domain:** Browser-to-browser WebRTC audio calling app
**Project:** WebRTC Phone
**Researched:** 2026-05-25
**Confidence:** HIGH — WebRTC peer connection API and signaling patterns are stable W3C/IETF standards

---

## Component Boundaries

| Component | Location | Responsibility | Does NOT do |
|-----------|----------|---------------|-------------|
| Signaling Server | Node.js process | Room registry, socket relay of SDP + ICE messages | Touch audio; understand WebRTC internals |
| RTCPeerConnection | Browser native API | ICE negotiation, DTLS-SRTP setup, codec negotiation | UI, socket management |
| MediaStream / getUserMedia | Browser native API | Capture microphone, produce audio track | Transport — that is RTCPeerConnection's job |
| Socket.io Client | Browser JS module | Send/receive signaling events | Peer-to-peer anything |
| React UI Layer | Browser React | Render call state, trigger user actions, display status | WebRTC or socket logic directly — use a hook |
| STUN Server | External (Google public) | Reflect public IP:port for NAT traversal | Carry media; relay data |

---

## Data Flow: Signaling Sequence (step by step)

### Phase 0 — Room Join

Peer A emits `join-room(roomCode)`. Server stores socket A against the room code. When Peer B emits `join-room(roomCode)`, server emits `peer-joined` to socket A. This is the trigger for Peer A to begin the offer.

### Phase 1 — Media Capture (both peers independently)

`getUserMedia({ audio: true })` → `MediaStream` → `pc.addTrack(track, stream)`. Adding the track fires `onnegotiationneeded`, which is the hook to call `createOffer`. Do not call `createOffer` on a timer; use this event.

### Phase 2 — Offer (Peer A)

`pc.createOffer()` → `pc.setLocalDescription(offer)` → `socket.emit('offer', offer)` → server relays to Peer B. `setLocalDescription` starts ICE gathering on Peer A.

### Phase 3 — Answer (Peer B)

Peer B receives offer → `pc.setRemoteDescription(offer)` → `pc.createAnswer()` → `pc.setLocalDescription(answer)` → `socket.emit('answer', answer)` → server relays to Peer A. Peer B's ICE gathering begins here.

### Phase 4 — ICE Candidate Trickle (both peers, concurrent with phases 2-3)

Each peer's `pc.onicecandidate` fires per candidate → `socket.emit('ice-candidate', candidate)` → server relays → remote peer calls `pc.addIceCandidate(candidate)`. Queue candidates that arrive before `setRemoteDescription` resolves.

### Phase 5 — Connection Established

`pc.onconnectionstatechange` → `"connected"`. `pc.ontrack` fires with remote `MediaStream`. Attach: `audioElement.srcObject = event.streams[0]`. Audio is now flowing peer-to-peer.

### Phase 6 — Teardown

Either peer emits `leave`. Server emits `peer-left` to the other socket and deletes the room entry. Both peers call `track.stop()` and `pc.close()`.

---

## Build Order

```
Step 1: Signaling Server
        Room join/leave, relay events (offer, answer, ice-candidate), disconnect cleanup.
        UNBLOCKS EVERYTHING. Nothing else can be tested without this.

Step 2: Media Capture
        getUserMedia, expose local stream, mute toggle (track.enabled).
        UNBLOCKS Step 3 — a track must exist before an SDP offer can be created.

Step 3: RTCPeerConnection + Signaling Integration
        Create pc with STUN config, offer/answer exchange, ICE trickle, ontrack handler.
        UNBLOCKS Step 4 — need a remote stream before there is anything to play.

Step 4: Audio Playback
        <audio> element, srcObject = remoteStream, autoplay.
        First end-to-end call verification point.

Step 5: React UI + useWebRTC Hook
        Room code entry/generation, call status display, mute/hang-up buttons.
        useWebRTC encapsulates steps 2-4. Final integration.

Step 6: NAT Traversal Verification (post-integration)
        Test across real networks. Add TURN only if direct P2P fails.
        Do not add TURN prematurely — it adds cost and complexity.
```

---

## Room Management Pattern

Server-side in-memory map:

```
rooms: Map<roomCode, { sockets: [socketId_A, socketId_B] }>
```

- Room created when first peer joins with a code.
- Room becomes "ready" when second peer joins — server emits `peer-joined` to the first peer.
- Cap at 2 sockets; reject a third join attempt.
- Room deleted on either peer's `socket.disconnect` event. The remaining peer receives `peer-left` and cleans up its peer connection.
- No persistence needed — rooms are ephemeral by design.

---

## Critical Architecture Notes

1. **Three-tier at setup, two-tier at runtime.** The signaling server is only in the path during handshake. Once `connectionState === "connected"`, audio flows peer-to-peer via SRTP/DTLS and the server is idle.
2. **Track-before-offer ordering.** `getUserMedia` must resolve and the track must be added to `RTCPeerConnection` before `createOffer` is called. Silent call failure, no exception thrown.
3. **ICE candidate race condition.** Remote candidates can arrive before `setRemoteDescription` completes. Queue and flush after the remote description is set.
4. **Mic not released on teardown.** `track.stop()` must be called explicitly. Browser recording indicator stays active otherwise.

---

## Open Questions

- TURN server: Not needed for localhost testing, but cross-network calls behind symmetric NAT will fail without one. Defer until Phase 6 testing reveals the need.
- Socket event naming (`join-room`, `peer-joined`, `offer`, `answer`, `ice-candidate`, `leave`, `peer-left`) is conventional. Any consistent naming works — what matters is the sequence.
