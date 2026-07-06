// Dev: Vite serves the client on :5173 and the signaling server runs on :3001.
// Prod: the server serves the built client, so both share one origin.
export const SERVER_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

// STUN only. Add a TURN entry here if cross-network calls stall in ICE
// 'checking' / reach 'failed' (symmetric NAT) — see PLANNING.md Phase 4.
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};
