import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Normalizes WebRTC API differences across browsers; import once, first.
import 'webrtc-adapter';
import './index.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
