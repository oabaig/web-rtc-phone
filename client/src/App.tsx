import { lazy, Suspense, useEffect, useState } from 'react';
import { CallScreen } from './components/CallScreen';
import { Home } from './components/Home';
import './App.css';

// Loaded on demand: SIP.js is most of its weight, and room calls never need it.
const PhoneScreen = lazy(() =>
  import('./components/PhoneScreen').then((m) => ({ default: m.PhoneScreen })),
);

// '#/phone' opens the PBX softphone. Room codes can't contain '/', so it
// never collides with a room.
const PHONE_HASH = '#/phone';

// The room code lives in the URL hash (#ABC123) so links are shareable
// without a router: same URL on both ends means same room.
function roomFromHash(hash: string): string {
  return decodeURIComponent(hash.replace(/^#/, '')).toUpperCase();
}

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const goHome = () => (window.location.hash = '');

  if (hash === PHONE_HASH) {
    return (
      <Suspense>
        <PhoneScreen onLeave={goHome} />
      </Suspense>
    );
  }

  const roomCode = roomFromHash(hash);
  if (!roomCode) {
    return (
      <Home
        onJoin={(code) => (window.location.hash = code)}
        onOpenPhone={() => (window.location.hash = PHONE_HASH)}
      />
    );
  }
  return <CallScreen key={roomCode} roomCode={roomCode} onLeave={goHome} />;
}
