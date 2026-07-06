# Domain Pitfalls: WebRTC Audio Calling App

**Domain:** Browser-to-browser WebRTC audio calling (React + Node.js + Socket.io)
**Researched:** 2026-05-25
**Confidence:** HIGH — all pitfalls verified against current MDN WebRTC documentation

---

## Critical Pitfalls

### Pitfall 1: ICE Candidates Arriving Before `setRemoteDescription`

**What goes wrong:**
Remote ICE candidates arrive via the signaling channel and code calls `addIceCandidate()` immediately. If `setRemoteDescription()` has not yet been called, the browser throws `InvalidStateError` and the candidate is dropped. The peers end up with an incomplete candidate pool and fail to connect or fall back to TURN unnecessarily.

**Why it happens:** Signaling is asynchronous. Candidates from the caller arrive while the callee's `setRemoteDescription()` is still resolving. Especially common on fast networks.

**Consequences:** `addIceCandidate()` throws `InvalidStateError`; candidate pool incomplete; connection fails intermittently; works locally, breaks on real networks.

**Prevention:** Buffer incoming ICE candidates; drain after `setRemoteDescription()` resolves.

```javascript
const iceCandidateBuffer = [];
let remoteDescriptionSet = false;

async function handleRemoteDescription(sdp) {
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  remoteDescriptionSet = true;
  for (const candidate of iceCandidateBuffer) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
  iceCandidateBuffer.length = 0;
}

function handleIceCandidate(candidate) {
  if (!remoteDescriptionSet) {
    iceCandidateBuffer.push(candidate);
  } else {
    pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
}
```

**Warning signs:** `InvalidStateError` in console; call works from localhost but fails across real devices; ICE state stays `checking` then `failed`.

**Phase:** Signaling layer — implement during initial peer connection wiring.

---

### Pitfall 2: Offer/Answer Collision ("Glare") Without a Resolution Strategy

**What goes wrong:**
Both peers trigger `onnegotiationneeded` simultaneously. Each sends an offer. Without collision handling, one peer calls `setRemoteDescription()` with an offer while `signalingState` is already `have-local-offer`. Connection stalls indefinitely.

**Why it happens:** Users may arrive within milliseconds of each other. Naive "first user creates an offer" is a race condition.

**Consequences:** Connection hangs with `signalingState` stuck at `have-local-offer`. Only appears when both join within a short window — passes solo testing.

**Prevention:** Use the WebRTC Perfect Negotiation pattern. Assign "polite" (yields) and "impolite" (ignores collision) roles at room join time.

```javascript
const makingOffer = { current: false };

pc.onnegotiationneeded = async () => {
  try {
    makingOffer.current = true;
    await pc.setLocalDescription();
    signalingChannel.send({ description: pc.localDescription });
  } finally {
    makingOffer.current = false;
  }
};

signalingChannel.onmessage = async ({ description, candidate }) => {
  if (description) {
    const offerCollision =
      description.type === 'offer' &&
      (makingOffer.current || pc.signalingState !== 'stable');
    if (!polite && offerCollision) return;
    await pc.setRemoteDescription(description);
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      signalingChannel.send({ description: pc.localDescription });
    }
  }
};
```

**Warning signs:** Works when one user joins 5+ seconds after the other; fails on simultaneous join; `signalingState` is `have-local-offer` when incoming offer arrives.

**Phase:** Signaling + peer connection wiring — design for this from the start.

---

### Pitfall 3: `getUserMedia` Silently Unavailable on HTTP in Production

**What goes wrong:**
App works on `localhost`. Deploy to plain HTTP and `navigator.mediaDevices` is `undefined`. `getUserMedia()` throws `TypeError: Cannot read properties of undefined`. No mic permission dialog appears.

**Why it happens:** The browser exposes `navigator.mediaDevices` only in secure contexts (HTTPS, `localhost`, `file://`). On HTTP, the property is `undefined` — not restricted, literally absent. By spec.

**Prevention:**
- Deploy behind HTTPS from day one
- Add an explicit guard:

```javascript
if (!window.isSecureContext) {
  showError('This app requires a secure (HTTPS) connection.');
  return;
}
```

**Warning signs:** `navigator.mediaDevices` is `undefined`; `TypeError` on call start (not `NotAllowedError`); works on localhost, fails on deployed URL.

**Phase:** Infrastructure — HTTPS must be solved before cross-device testing.

---

### Pitfall 4: NAT Traversal Failure — STUN Alone Is Not Enough

**What goes wrong:**
STUN configured. Call works in testing. Fails for some users on corporate or mobile carrier networks (symmetric NAT). ICE state reaches `failed`. Silence, no error message.

**Why it happens:** STUN discovers a peer's public IP/port but cannot help with Symmetric NAT where each outbound connection maps to a unique external port. TURN relays all traffic through a server — the only solution.

**Consequences:** ~15–20% of real-world connections fail with STUN only; non-deterministic from a dev environment; no in-call feedback.

**Prevention:** Add TURN credentials to `RTCPeerConnection` config as a fallback. Free-tier: Metered.ca, Cloudflare Calls.

```javascript
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:your.turn.server:3478',
      username: 'user',
      credential: 'pass',
    },
  ],
});
```

**Warning signs:** Works on home network / between tabs but fails from phone on mobile data; ICE state reaches `failed` after ~30s of `checking`.

**Phase:** Infrastructure — add TURN before cross-network testing.

---

### Pitfall 5: React State and Async WebRTC Event Handlers Desynchronised

**What goes wrong:**
WebRTC events fire asynchronously. Handlers created as closures over React `useState` capture a stale snapshot from the render cycle when they were created, not the current value.

**Why it happens:** React creates new closures on each render; event handlers attached to `RTCPeerConnection` are attached once and never updated.

**Consequences:** ICE candidates sent to wrong peer; remote stream assigned to replaced DOM element; call status out of sync with actual WebRTC state.

**Prevention:** Store `RTCPeerConnection` instance, streams, and signaling identifiers in `useRef`. Use `useState` only for values that drive re-renders (call status, mute indicator).

```javascript
const pcRef = useRef(null);

useEffect(() => {
  const pc = new RTCPeerConnection(config);
  pcRef.current = pc;

  pc.ontrack = (e) => {
    remoteAudioRef.current.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    setCallStatus('connected'); // setter is stable — safe to call here
  };
}, []);
```

**Warning signs:** Handlers fire (visible in logs) but have no effect; stale values in console logs inside handlers; works on first call, breaks on subsequent calls.

**Phase:** Frontend React wiring — establish this pattern at initial implementation.

---

### Pitfall 6: Forgetting to Clean Up on Component Unmount or Call End

**What goes wrong:**
`pc.close()` is called but `MediaStreamTrack` instances are not stopped. Browser mic indicator stays on. Future calls to `getUserMedia()` may reuse a live-but-broken track.

**Why it happens:** `RTCPeerConnection.close()` terminates the ICE agent but does NOT call `stop()` on `MediaStreamTrack` objects. React does not automatically detach listeners from non-React objects.

**Prevention:**
```javascript
useEffect(() => {
  const pc = new RTCPeerConnection(config);
  let localStream = null;

  // ... setup ...

  return () => {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    pc.close();
    pcRef.current = null;
  };
}, []);
```

**Warning signs:** Browser mic indicator stays on after navigating away; React StrictMode causes double connection; `signalingState === 'closed'` errors after call ends.

**Phase:** Frontend React component — implement in the same phase as `getUserMedia` creation.

---

## Moderate Pitfalls

### Pitfall 7: Using Deprecated `addStream` / `addstream` from Old Tutorials

Many tutorials (2018–2022) use `pc.addStream(stream)` and `addstream` event — both removed from modern browsers.

**Prevention:** Use `pc.addTrack(track, stream)` and the `track` event. Check tutorial publication dates.

**Phase:** Any phase touching `RTCPeerConnection` setup.

---

### Pitfall 8: Remote Audio Track Not Attached Correctly

`e.streams` in the `track` event can be an empty array. `remoteAudio.srcObject = e.streams[0]` assigns `undefined`. No audio, no error.

```javascript
pc.ontrack = (e) => {
  const stream = e.streams[0] ?? new MediaStream([e.track]);
  remoteAudioRef.current.srcObject = stream;
};
```

Set `autoplay` on `<audio>` and handle `play()` promise rejections.

---

### Pitfall 9: No User-Visible Feedback on ICE Failure

When ICE reaches `failed`, nothing in the UI changes. Call screen shows "connecting…" indefinitely.

**Prevention:** Map `iceConnectionState` to user-facing messages. Show "could not connect" + retry on `failed`.

---

### Pitfall 10: Socket.io Room Broadcast Echoes Back to Sender

Using `io.in(roomId).emit(...)` sends to all sockets including the sender. The sender's peer connection receives its own offer/answer, causing state machine errors.

```javascript
// Correct — everyone except sender
socket.to(roomId).emit('signal', data);

// Wrong — echoes to sender
io.in(roomId).emit('signal', data);
```

**Phase:** Signaling server — verify before any peer connection wiring.

---

## Minor Pitfalls

### Pitfall 11: Missing `await` on WebRTC Async Calls

`setLocalDescription` and `setRemoteDescription` return Promises. Without `await`, subsequent operations run before the description is applied, producing intermittent `InvalidStateError`.

**Prevention:** Always `await` every WebRTC async call.

---

### Pitfall 12: Testing Only on the Same Machine

Browser tabs on the same machine use loopback — no STUN, no NAT, no ICE checking. Everything works. Two separate devices on different networks expose all hidden bugs.

**Prevention:** Cross-device, cross-network testing should happen before the end of Phase 1. Use Ngrok or a deployed HTTPS server.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|---|---|---|
| Signaling server setup | Socket.io broadcast echoes back to sender | Use `socket.to(room).emit()` not `io.in(room).emit()` |
| Peer connection wiring | Async calls without await | Enforce `async/await` throughout |
| ICE candidate exchange | Candidates arrive before remote description is set | Implement candidate buffer from day one |
| React call component | Stale closure over state in event handlers | Use `useRef` for connection objects |
| First end-to-end test | Works locally, fails cross-device (NAT or HTTP) | Test cross-network early; HTTPS before cross-device test |
| Call end / hang up | Microphone stays on; stale handlers remain | Full `useEffect` cleanup returning a function |
| Simultaneous join | Offer collision stalls connection silently | Perfect Negotiation pattern with polite/impolite roles |
| Production deployment | HTTP breaks `getUserMedia` with TypeError | HTTPS from first deployment; add `isSecureContext` guard |
| Real-world users | ~15–20% fail STUN-only (Symmetric NAT) | Add TURN fallback before sharing outside dev |
