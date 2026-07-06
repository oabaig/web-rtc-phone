# Feature Landscape

**Domain:** Browser-to-browser WebRTC audio calling app
**Project:** WebRTC Phone
**Researched:** 2026-05-25
**Confidence:** HIGH (WebRTC is a mature, well-documented browser standard; patterns are stable)

---

## Table Stakes

Features users expect from any real-time calling app. Missing or broken = the app does not work.

| Feature | Why Expected | Complexity | Dependencies | Notes |
|---------|--------------|------------|--------------|-------|
| Room creation with shareable code | Entry point for all calls; without it there is no rendezvous | Low | Socket.io room model | UUID or short alphanumeric code; no auth needed |
| Join room via code or URL | The second user must have a way in | Low | Room creation | URL param or manual code entry |
| Live bidirectional audio | The entire product; silence = broken | High | getUserMedia, RTCPeerConnection, STUN | Core WebRTC peer connection + ICE negotiation |
| Mute / unmute local microphone | Universal call control; absence feels broken (forces hang-up to silence) | Low | Active MediaStream track | `track.enabled = false/true` — one property; no renegotiation needed |
| Leave / end call | User must be able to exit cleanly; closing the tab leaves remote peer hanging | Low | RTCPeerConnection, Socket.io disconnect | Close peer connection + emit disconnect signal |
| Call connected / connecting state feedback | Without UI feedback the user cannot tell if the call is working | Low | RTCPeerConnection `iceConnectionState` events | Show "Connecting" → "Connected" → "Disconnected" |
| Remote peer disconnected notification | User must know when the other person left; silence is ambiguous | Low | Socket.io disconnect event or ICE failure | Brief "Call ended" message; auto-cleanup |
| Cross-network call (NAT traversal) | Works on localhost but not across real networks = not a real call | Medium | STUN server | Google's public STUN (stun.l.google.com:19302) handles ~85% of cases |
| HTTPS in production | Browser blocks `getUserMedia` on insecure origins | Low (config) | Hosting setup | localhost is exempt; production needs TLS — hard prerequisite, not a code feature |

---

## Differentiators

Features that elevate the experience beyond "works." Not expected at MVP, but add polish or learning depth.

| Feature | Value Proposition | Complexity | Dependencies | Notes |
|---------|-------------------|------------|--------------|-------|
| Microphone permission error handling | Clear error when mic is blocked; without it the call silently fails | Low | `getUserMedia` rejection handling | Catch `NotAllowedError`, `NotFoundError`; display actionable message |
| Copy room link to clipboard | Reduces friction sharing the room code | Low | Clipboard API | `navigator.clipboard.writeText()` — trivial |
| Persistent room URL (bookmark-able) | Both parties open the same URL directly | Low | URL routing (React Router or `window.location`) | Room code as URL hash or path param |
| Call duration timer | Familiar call-screen element | Low | `setInterval` from connection timestamp | No WebRTC dependency; pure UI |
| Peer display name | Personalizes the call screen | Low | Socket.io handshake payload | Text field before join; no auth needed |
| Speaking indicator (voice activity detection) | Visual confirmation audio is flowing; reduces "can you hear me?" | Medium | Web Audio API AnalyserNode on stream | Poll `getByteFrequencyData` on animation frame |
| Audio device selector (mic input) | Lets user pick headset vs built-in mic | Low-Medium | `MediaDevices.enumerateDevices()`, `replaceTrack` | Good exploration of `enumerateDevices` API |
| Connection quality indicator | Shows degradation before audio breaks | Medium | `RTCPeerConnection.getStats()` polling | Poll RTT and packet loss every 2-5 s |
| TURN server fallback | Handles symmetric NAT / corporate firewalls where STUN alone fails | Medium (ops) | TURN server (coturn or hosted) | ~15% of calls need TURN; Twilio and Metered offer free tiers |
| Reconnect on ICE failure | Recovers from transient network drop without full page reload | High | ICE restart (`iceRestart: true` in `createOffer`) | `iceConnectionState === "failed"` → renegotiate; complex but deep learning surface |

---

## Anti-Features

Things to deliberately NOT build. Explicitly scoping out prevents creep and keeps focus on WebRTC learning.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Video | Adds track complexity, layout concerns, bandwidth management — orthogonal to audio learning | Stay audio-only; `getUserMedia({ audio: true, video: false })` |
| Multi-party calls (3+ users) | Requires mesh or SFU/MCU — entire new architecture | Two peers only; one RTCPeerConnection |
| User accounts / authentication | Auth is a product concern, not a WebRTC concern | Ephemeral rooms; no login |
| Call recording | `MediaRecorder` + storage + privacy considerations | Exclude entirely |
| Text chat in-call | DataChannel alongside audio — good follow-up project, not MVP | Phase 2 candidate: DataChannel exploration |
| Push notifications | Service workers, push API, backend subscription management | Not applicable to pull-based room model |
| Mobile native apps | React Native WebRTC has different quirks; separate concern | Browser only |
| Custom E2E encryption layer | DTLS-SRTP is already mandatory in WebRTC — browser handles it | Trust the spec; document that DTLS-SRTP is the transport layer |
| Room persistence / history | DB adds ops complexity; rooms are ephemeral by design | In-memory room state on server; lost on restart |
| Waiting room / queue | Only meaningful for multi-party | Not applicable |

---

## Feature Dependencies

```
Room creation (code/UUID generated)
    └─> Room join (code or URL)
            └─> getUserMedia (mic permission + stream)
                    └─> RTCPeerConnection + SDP offer/answer (via Socket.io signaling)
                            └─> ICE candidate exchange (STUN required)
                                    └─> Live bidirectional audio (P2P stream established)
                                            ├─> Mute/unmute (track.enabled toggle)
                                            ├─> Speaking indicator (Web Audio AnalyserNode on stream)
                                            ├─> Connection quality (getStats() on RTCPeerConnection)
                                            └─> Leave call (close RTCPeerConnection + socket event)

Audio device selector
    └─> getUserMedia (must have stream first)
            └─> replaceTrack (on active sender)

TURN server
    └─> ICE candidate exchange (fallback path — STUN first, TURN second)
```

---

## MVP Recommendation

**Build for MVP (Phase 1):**
1. Room creation + join (code + URL param)
2. getUserMedia with `NotAllowedError` / `NotFoundError` handling
3. RTCPeerConnection with STUN — the core learning surface
4. Mute/unmute
5. Call state feedback (connecting / connected / disconnected via `iceConnectionState`)
6. Remote peer disconnect notification
7. Leave call (clean teardown)
8. Copy room link to clipboard (trivial, high friction reduction)

**Defer to Phase 2 (polish + deeper WebRTC):**
- Speaking indicator — Web Audio API exploration
- Connection quality via `getStats()` — teaches the WebRTC stats model
- Audio device selector — teaches `enumerateDevices` and `replaceTrack`
- TURN fallback — add when cross-network testing reveals failures
- Peer display name

**Phase 3 / stretch goal:**
- DataChannel text chat — best follow-on; teaches the other major WebRTC primitive
- ICE restart / reconnect — advanced but high learning value

---

## Confidence Notes

| Area | Confidence | Reason |
|------|------------|--------|
| Table stakes features | HIGH | WebRTC browser API is W3C standard; `getUserMedia`, `RTCPeerConnection`, ICE are stable and well-documented |
| Mute complexity (Low) | HIGH | `MediaStreamTrack.enabled` is a single property — confirmed in MDN spec |
| STUN/TURN split (~85/15%) | MEDIUM | Commonly cited in WebRTC literature; exact ratio varies by network topology |
| Differentiator complexity ratings | HIGH | `getStats()`, `AnalyserNode`, `enumerateDevices` are stable browser APIs with known integration patterns |
| Anti-feature rationale | HIGH | Grounded in constraints defined in PROJECT.md |
