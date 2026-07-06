import { useRef, useState } from 'react';
import { useCall } from '../hooks/useCall';
import type { CallPhase } from '../types';

const PHASE_LABEL: Record<CallPhase, string> = {
  joining: 'Joining room…',
  waiting: 'Waiting for the other person…',
  connecting: 'Connecting…',
  connected: 'Connected',
  ended: 'Call ended',
  error: 'Something went wrong',
};

export function CallScreen({
  roomCode,
  onLeave,
}: {
  roomCode: string;
  onLeave: () => void;
}) {
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const { phase, isMuted, message, toggleMute, hangUp } = useCall(
    roomCode,
    remoteAudioRef,
  );
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const inCall = phase === 'connecting' || phase === 'connected';
  const over = phase === 'ended' || phase === 'error';

  return (
    <main className="card">
      <div className="room-code">
        Room <strong>{roomCode}</strong>
        <button className="link" onClick={copyLink}>
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>

      <div className={`status status-${phase}`}>
        <span className="status-dot" />
        {PHASE_LABEL[phase]}
      </div>
      {message && <p className="message">{message}</p>}
      {phase === 'waiting' && (
        <p className="hint">Share the link — the call starts when they open it.</p>
      )}

      {/* Remote peer's audio; the useCall hook sets srcObject in ontrack. */}
      <audio ref={remoteAudioRef} autoPlay />

      <div className="controls">
        {inCall && (
          <button onClick={toggleMute}>{isMuted ? 'Unmute' : 'Mute'}</button>
        )}
        {!over ? (
          <button className="danger" onClick={hangUp}>
            {inCall ? 'Hang up' : 'Leave'}
          </button>
        ) : (
          <>
            <button onClick={() => window.location.reload()}>Rejoin</button>
            <button onClick={onLeave}>Back to home</button>
          </>
        )}
      </div>
    </main>
  );
}
