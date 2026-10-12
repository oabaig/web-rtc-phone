import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { usePhone } from '../hooks/usePhone';
import {
  clearSipSettings,
  loadSipSettings,
  saveSipSettings,
  type SipSettings,
} from '../phoneTypes';

/**
 * Softphone mode: the browser registers as an extension on the PBX and can
 * dial numbers and take calls. Shows the settings form until an extension
 * has been configured in this browser.
 */
export function PhoneScreen({ onLeave }: { onLeave: () => void }) {
  const [settings, setSettings] = useState(loadSipSettings);
  const [editing, setEditing] = useState(settings === null);
  // "Reconnect" bumps this; the new key remounts Softphone, and with it a
  // fresh user agent and registration.
  const [attempt, setAttempt] = useState(0);

  if (editing || !settings) {
    return (
      <SettingsForm
        initial={settings}
        onSave={(next) => {
          saveSipSettings(next);
          setSettings(next);
          setEditing(false);
        }}
        onCancel={settings ? () => setEditing(false) : onLeave}
        onForget={() => {
          clearSipSettings();
          onLeave();
        }}
      />
    );
  }

  return (
    <Softphone
      key={attempt}
      settings={settings}
      onReconnect={() => setAttempt((n) => n + 1)}
      onEditSettings={() => setEditing(true)}
      onLeave={onLeave}
    />
  );
}

function Softphone({
  settings,
  onReconnect,
  onEditSettings,
  onLeave,
}: {
  settings: SipSettings;
  onReconnect: () => void;
  onEditSettings: () => void;
  onLeave: () => void;
}) {
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const phone = usePhone(settings, remoteAudioRef);
  const [number, setNumber] = useState('');

  // The synthesised ring can be silent until the page has had a click, so
  // also flag an incoming call in the tab title.
  useEffect(() => {
    if (phone.call !== 'incoming') return;
    const previous = document.title;
    document.title = `Incoming call — ${phone.remoteParty}`;
    return () => {
      document.title = previous;
    };
  }, [phone.call, phone.remoteParty]);

  function dial(e: FormEvent) {
    e.preventDefault();
    // Keep what a dial plan understands; drop spaces, dashes and brackets.
    const target = number.replace(/[^\d*#+]/g, '');
    if (target) phone.dial(target);
  }

  const [statusClass, statusLabel] = describeStatus(phone);
  const ready = phone.registration === 'registered';

  return (
    <main className="card">
      <div className="room-code">
        Extension <strong>{settings.username}</strong>
        <button className="link" onClick={onEditSettings} disabled={phone.call !== 'idle'}>
          Settings
        </button>
      </div>

      <div className={`status status-${statusClass}`}>
        <span className="status-dot" />
        {statusLabel}
      </div>
      {phone.message && <p className="message">{phone.message}</p>}

      {/* Far end's audio — the PBX's leg of the call; usePhone sets srcObject. */}
      <audio ref={remoteAudioRef} autoPlay />

      {phone.call === 'idle' && (
        <form className="phone-form" onSubmit={dial}>
          <input
            type="tel"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="Number or extension"
            aria-label="Number to call"
            autoComplete="off"
          />
          <Dialpad onPress={(key) => setNumber((n) => n + key)} />
          <button type="submit" className="primary" disabled={!ready || !number.trim()}>
            Call
          </button>
        </form>
      )}

      {/* In-call keypad sends DTMF, for IVR menus and voicemail PINs. */}
      {phone.call === 'active' && <Dialpad onPress={phone.sendDtmf} />}

      <div className="controls">
        {phone.call === 'incoming' && (
          <>
            <button className="primary" onClick={phone.answer}>
              Answer
            </button>
            <button className="danger" onClick={phone.decline}>
              Decline
            </button>
          </>
        )}
        {phone.call === 'active' && (
          <button onClick={phone.toggleMute}>{phone.isMuted ? 'Unmute' : 'Mute'}</button>
        )}
        {(phone.call === 'outgoing' || phone.call === 'active') && (
          <button className="danger" onClick={phone.hangUp}>
            {phone.call === 'outgoing' ? 'Cancel' : 'Hang up'}
          </button>
        )}
        {phone.call === 'idle' && (
          <>
            {(phone.registration === 'error' || phone.registration === 'unregistered') && (
              <button onClick={onReconnect}>Reconnect</button>
            )}
            <button onClick={onLeave}>Back to home</button>
          </>
        )}
      </div>
    </main>
  );
}

/** Status line: the call when there is one, otherwise the registration. */
function describeStatus(phone: ReturnType<typeof usePhone>): [string, string] {
  switch (phone.call) {
    case 'outgoing':
      return ['connecting', `Calling ${phone.remoteParty}…`];
    case 'incoming':
      return ['connecting', `Incoming call from ${phone.remoteParty}`];
    case 'active':
      return ['connected', `On a call with ${phone.remoteParty}`];
    case 'idle':
      switch (phone.registration) {
        case 'connecting':
          return ['connecting', 'Connecting to the PBX…'];
        case 'registered':
          return ['connected', 'Ready'];
        case 'unregistered':
          return ['error', 'Not registered'];
        case 'error':
          return ['error', 'Not connected'];
      }
  }
}

const DIALPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

function Dialpad({ onPress }: { onPress: (key: string) => void }) {
  return (
    <div className="dialpad">
      {DIALPAD_KEYS.map((key) => (
        <button key={key} type="button" onClick={() => onPress(key)}>
          {key}
        </button>
      ))}
    </div>
  );
}

const EMPTY_SETTINGS: SipSettings = {
  server: '',
  domain: '',
  username: '',
  password: '',
  displayName: '',
};

function SettingsForm({
  initial,
  onSave,
  onCancel,
  onForget,
}: {
  initial: SipSettings | null;
  onSave: (settings: SipSettings) => void;
  onCancel: () => void;
  onForget: () => void;
}) {
  const [form, setForm] = useState(initial ?? EMPTY_SETTINGS);

  const field = (name: keyof SipSettings) => ({
    value: form[name],
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [name]: e.target.value })),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const server = form.server.trim();
    onSave({
      ...form,
      server,
      username: form.username.trim(),
      // The address of record is usually user@<PBX host>.
      domain: form.domain.trim() || new URL(server).hostname,
      displayName: form.displayName.trim(),
    });
  }

  return (
    <main className="card">
      <h1>Connect to your PBX</h1>
      <p className="subtitle">
        Registers this browser as an extension so it can make and take calls. Settings
        are saved in this browser only.
      </p>

      <form className="settings-form" onSubmit={submit}>
        <label>
          WebSocket URL
          <input
            {...field('server')}
            type="url"
            required
            pattern="wss?://.+"
            placeholder="wss://pbx.example.com:8089/ws"
          />
        </label>
        <label>
          Username
          <input {...field('username')} required autoComplete="username" />
        </label>
        <label>
          Password
          <input
            {...field('password')}
            type="password"
            required
            autoComplete="current-password"
          />
        </label>
        <label>
          SIP domain <span className="optional">optional</span>
          <input {...field('domain')} placeholder="Defaults to the WebSocket URL's host" />
        </label>
        <label>
          Display name <span className="optional">optional</span>
          <input {...field('displayName')} />
        </label>

        <div className="controls">
          <button type="submit" className="primary">
            Save and connect
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
        {initial && (
          <button type="button" className="link" onClick={onForget}>
            Forget these settings
          </button>
        )}
      </form>
    </main>
  );
}
