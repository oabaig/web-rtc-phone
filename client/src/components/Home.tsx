import { useState, type FormEvent } from 'react';

// No 0/O, 1/I/L — room codes get read aloud and retyped.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateRoomCode(): string {
  const values = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(values, (v) => CODE_ALPHABET[v % CODE_ALPHABET.length]).join('');
}

export function Home({ onJoin }: { onJoin: (roomCode: string) => void }) {
  const [code, setCode] = useState('');

  function handleJoin(e: FormEvent) {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (trimmed) onJoin(trimmed);
  }

  return (
    <main className="card">
      <h1>WebRTC Phone</h1>
      <p className="subtitle">
        Start a room, share the link, and talk — audio flows directly between
        your browsers.
      </p>

      <button className="primary" onClick={() => onJoin(generateRoomCode())}>
        Create a room
      </button>

      <div className="divider">or join one</div>

      <form onSubmit={handleJoin} className="join-form">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Room code"
          aria-label="Room code"
          maxLength={32}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="submit" disabled={!code.trim()}>
          Join
        </button>
      </form>
    </main>
  );
}
