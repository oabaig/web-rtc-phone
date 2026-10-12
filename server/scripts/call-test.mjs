/**
 * End-to-end call test: drives two headless Chrome/Edge tabs through a real
 * call against the running server (which must be serving client/dist).
 *
 *   node scripts/call-test.mjs
 *
 * Chrome's fake-media flags substitute a generated tone for the microphone,
 * so the full path — getUserMedia, SDP exchange, ICE, DTLS-SRTP — runs
 * exactly as in a real call, without hardware.
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.SERVER_URL ?? 'http://localhost:3001';
const ROOM = `E2E${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const executablePath = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Edge found (set CHROME_PATH)');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream', // auto-grant mic permission
    '--use-fake-device-for-media-stream', // tone generator instead of hardware
    '--mute-audio',
    '--no-sandbox',
    // Both tabs must keep running while backgrounded.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

async function waitForStatus(page, text, timeout = 25000) {
  // Interval polling, not the default rAF: rAF doesn't fire in background
  // tabs, and one of the two tabs is always backgrounded.
  await page.waitForFunction(
    (t) => document.querySelector('.status')?.textContent?.includes(t) ?? false,
    { timeout, polling: 200 },
    text,
  );
}

try {
  await browser.defaultBrowserContext().overridePermissions(BASE, ['microphone']);

  const alice = await browser.newPage();
  const bob = await browser.newPage();
  for (const [name, page] of [['alice', alice], ['bob', bob]]) {
    page.on('pageerror', (err) => console.error(`[${name}] pageerror:`, err.message));
  }

  await alice.goto(`${BASE}/#${ROOM}`);
  await waitForStatus(alice, 'Waiting');
  check('first tab waits alone in the room', true);

  await bob.goto(`${BASE}/#${ROOM}`);
  await waitForStatus(alice, 'Connected');
  await waitForStatus(bob, 'Connected');
  check('both tabs reach Connected (ICE + DTLS complete)', true);

  const remoteAttached = await bob.evaluate(() => {
    const audio = document.querySelector('audio');
    const stream = audio?.srcObject;
    return !!stream && stream.getAudioTracks().length > 0;
  });
  check('remote audio track attached on second tab', remoteAttached);

  // Mute toggles the button label (track.enabled has no DOM side effect).
  await alice.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Mute')?.click();
  });
  const muted = await alice.evaluate(
    () => !![...document.querySelectorAll('button')].find((b) => b.textContent === 'Unmute'),
  );
  check('mute toggles', muted);

  // Hang up on one side -> other side is told the peer left.
  await alice.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Hang up')?.click();
  });
  // The remaining peer returns to waiting (not a dead end) with a notice.
  await waitForStatus(bob, 'Waiting');
  const bobMessage = await bob.evaluate(
    () => document.querySelector('.message')?.textContent ?? '',
  );
  check('peer is told the other side left', bobMessage.includes('left the call'));

  // Mic released on the side that hung up (checklist item 7).
  const micReleased = await alice.evaluate(() => !document.querySelector('audio')?.srcObject);
  check('remote audio detached after hang up', micReleased);

  // Rejoining the same room re-establishes the call from scratch.
  await alice.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Rejoin')?.click();
  });
  await waitForStatus(alice, 'Connected');
  await waitForStatus(bob, 'Connected');
  check('call re-establishes after rejoin', true);
} catch (err) {
  failures.push(String(err));
  console.error(`FAIL  ${err}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nEnd-to-end call test passed.');
