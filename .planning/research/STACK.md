# Stack

**Domain:** Browser-to-browser WebRTC audio calling app
**Project:** WebRTC Phone
**Researched:** 2026-05-25
**Confidence:** HIGH for browser APIs and React patterns; MEDIUM for library version numbers

---

## Recommended Stack

### Frontend

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| React | 18.x | UI framework | Pre-chosen; hooks model maps onto WebRTC's event-driven lifecycle | HIGH |
| Vite | 5.x / 6.x | Build tool / dev server | Fastest React setup; HMR is instant; `create vite` is the current standard | MEDIUM |
| TypeScript | 5.x | Type safety | RTCPeerConnection states are string literals — types catch misspellings in event handlers | HIGH |
| webrtc-adapter | 9.x | Cross-browser shim | MDN explicitly recommends it; normalizes API differences across Chrome/Firefox/Safari/Edge | MEDIUM |

### Signaling Server

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Node.js | 20 LTS | Runtime | LTS line; stable | HIGH |
| socket.io (server) | 4.7.x | Signaling transport | Pre-chosen; rooms built in; auto-reconnect; massive tutorial coverage for this exact use case | MEDIUM |
| socket.io-client | 4.7.x | Client socket | Must match server major version | MEDIUM |
| Express | 4.x / 5.x | HTTP server | Minimal; Socket.io needs an http.Server to attach to; no REST needed | MEDIUM |

### ICE Infrastructure

| Technology | Purpose | Notes | Confidence |
|------------|---------|-------|------------|
| `stun.l.google.com:19302` | STUN for NAT traversal | Free, no credentials; adequate for dev and learning | MEDIUM (no official Google SLA) |
| Metered.ca OpenRelay | TURN relay fallback | Free tier; use when P2P fails across real networks | MEDIUM |

---

## State Management Approach

**`useReducer` + `useRef` + custom `useCall` hook. No external state library.**

The call connection is a finite state machine:

```typescript
type CallPhase = 'idle' | 'joining' | 'waiting' | 'connecting' | 'connected' | 'ended' | 'error';

interface CallState {
  phase: CallPhase;
  iceConnectionState: RTCIceConnectionState | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMuted: boolean;
  error: string | null;
}
```

- `RTCPeerConnection` instance → `useRef` (mutable, imperative — in state would cause re-renders that disrupt the connection)
- Socket.io client instance → `useRef` (same reason)
- All WebRTC + Socket.io side effects → single `useCall` custom hook
- Components consume `callState` and `dispatch`; know nothing about `RTCPeerConnection` directly

---

## What NOT to Use

| Option | Why Not |
|--------|---------|
| **simple-peer / PeerJS** | Abstracts away the exact APIs you're trying to learn; defeats the project purpose |
| **Twilio / Agora / Daily.co** | Managed media servers; WebRTC is invisible; wrong for learning |
| **Redux / Zustand** | Overkill for single-page state with no cross-route sharing |
| **Raw `ws` Node.js package** | You'd hand-write room routing, reconnect logic, event framing — not the learning goal |
| **Socket.io v3 or below** | Breaking changes from v4; unmaintained |
| **`new RTCSessionDescription(sdp)`** | Constructor is deprecated; pass SDP object literal directly to `setLocalDescription` / `setRemoteDescription` |

---

## STUN / TURN Configuration

### Development (STUN only)

```javascript
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};
```

### When to add TURN

If `iceConnectionState` stays at `"checking"` indefinitely during cross-device testing, add TURN. Metered.ca OpenRelay provides free credentials on sign-up. Self-hosted `coturn` is the open-source alternative.

**Do not add TURN prematurely** — it adds cost, operational complexity, and routes media through a relay rather than peer-to-peer.

---

## Perfect Negotiation Pattern

MDN recommends Perfect Negotiation over the classic asymmetric caller/callee pattern:
- Symmetric code (same handler runs on both peers)
- Built-in collision resolution via polite/impolite roles
- Assign roles at room join time: first-to-join = polite, second-to-join = impolite

---

## Suggested Installation

```bash
# Frontend (React + Vite + TypeScript)
npm create vite@latest client -- --template react-ts
cd client
npm install socket.io-client webrtc-adapter

# Server (Node.js + Express + Socket.io)
mkdir server && cd server
npm init -y
npm install express socket.io
npm install -D typescript ts-node @types/node @types/express nodemon
```

---

## Confidence Summary

| Area | Level | Reason |
|------|-------|--------|
| WebRTC browser APIs | HIGH | Stable W3C standard; verified against MDN |
| React state management pattern | HIGH | Verified against React official docs |
| Socket.io choice rationale | HIGH | Architecture rationale grounded in project goals |
| Socket.io version (4.7.x) | MEDIUM | Training data; confirm at install with `npm info socket.io version` |
| Vite version | MEDIUM | Training data; verify at project start |
| Perfect Negotiation pattern | HIGH | Verified against MDN official docs |
| STUN (Google) | MEDIUM | Widely used; no official Google SLA |
