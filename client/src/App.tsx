import { useEffect, useState } from 'react';
import { CallScreen } from './components/CallScreen';
import { Home } from './components/Home';
import './App.css';

// The room code lives in the URL hash (#ABC123) so links are shareable
// without a router: same URL on both ends means same room.
function roomFromHash(): string {
  return decodeURIComponent(window.location.hash.replace(/^#/, '')).toUpperCase();
}

export default function App() {
  const [roomCode, setRoomCode] = useState(roomFromHash);

  useEffect(() => {
    const onHashChange = () => setRoomCode(roomFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (!roomCode) {
    return <Home onJoin={(code) => (window.location.hash = code)} />;
  }
  return (
    <CallScreen
      key={roomCode}
      roomCode={roomCode}
      onLeave={() => (window.location.hash = '')}
    />
  );
}
