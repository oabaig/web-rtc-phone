/**
 * End-to-end softphone test: drives headless Chrome through the #/phone
 * screen against a local Asterisk standing in for the PBX (dev/asterisk —
 * PBXware is Asterisk underneath, so it's the same WebRTC path).
 *
 *   docker build -t webrtc-phone-asterisk ../dev/asterisk
 *   docker run -d --rm --name webrtc-phone-asterisk --network host webrtc-phone-asterisk
 *   node scripts/phone-test.mjs
 *
 * The server must be running and serving client/dist, as for test:call.
 * Audio is checked from RTP counters in getStats(): the echo extension sends
 * our own (fake-mic) audio back, so packets flowing both ways means media
 * works end to end, not just signaling.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.SERVER_URL ?? 'http://localhost:3001';
const ASTERISK = process.env.ASTERISK_CONTAINER ?? 'webrtc-phone-asterisk';
// Matches dev/asterisk/pjsip.conf.
const SIP = { server: 'ws://127.0.0.1:8088/ws', username: 'webrtc1', password: 'webrtc1-test-only' };

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

function asterisk(command) {
  return execFileSync('docker', ['exec', ASTERISK, 'asterisk', '-rx', command], {
    encoding: 'utf8',
  });
}

/** Places a call from the PBX to the browser. Async: it rings until answered. */
function originateToBrowser() {
  execFile('docker', ['exec', ASTERISK, 'asterisk', '-rx', 'channel originate PJSIP/webrtc1 application Echo']);
}

try {
  asterisk('core show version');
} catch {
  console.error(`Asterisk container "${ASTERISK}" isn't running — see the header of this file.`);
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
  ],
});

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
}

async function waitForText(page, selector, text, timeout = 15000) {
  await page.waitForFunction(
    (s, t) => document.querySelector(s)?.textContent?.includes(t) ?? false,
    { timeout, polling: 200 },
    selector,
    text,
  );
}
const waitForStatus = (page, text, timeout) => waitForText(page, '.status', text, timeout);
const message = (page) => page.evaluate(() => document.querySelector('.message')?.textContent ?? '');

async function clickButton(page, label) {
  const clicked = await page.evaluate((l) => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === l && !b.disabled,
    );
    button?.click();
    return !!button;
  }, label);
  if (!clicked) throw new Error(`no enabled "${label}" button`);
}

async function replaceInput(page, selector, value) {
  // Select, then delete with a real keypress so React's onChange sees it.
  await page.$eval(selector, (el) => el.select());
  await page.keyboard.press('Backspace');
  await page.type(selector, value);
}

async function dial(page, number) {
  await replaceInput(page, '.phone-form input', number);
  await clickButton(page, 'Call');
}

/** Audio RTP packet totals on the newest peer connection. */
function rtp(page) {
  return page.evaluate(async () => {
    const pc = window.__peerConnections.at(-1);
    let sent = 0;
    let received = 0;
    for (const stat of (await pc.getStats()).values()) {
      if (stat.kind !== 'audio') continue;
      if (stat.type === 'outbound-rtp') sent += stat.packetsSent;
      if (stat.type === 'inbound-rtp') received += stat.packetsReceived;
    }
    return { sent, received };
  });
}

async function audioFlowsBothWays(page) {
  await sleep(1500);
  const before = await rtp(page);
  await sleep(1500);
  const after = await rtp(page);
  return after.sent > before.sent && after.received > before.received;
}

const channelsReleased = () =>
  waitFor(() => /^0 active channels?/m.test(asterisk('core show channels count')));

try {
  await browser.defaultBrowserContext().overridePermissions(BASE, ['microphone']);
  asterisk('database deltree test');

  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('pageerror:', err.message));
  // SIP.js owns the RTCPeerConnection; keep a handle on each one so the
  // test can read its stats.
  await page.evaluateOnNewDocument(() => {
    const Native = window.RTCPeerConnection;
    window.__peerConnections = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.__peerConnections.push(this);
      }
    };
  });

  // --- Registration ---------------------------------------------------------
  await page.goto(`${BASE}/#/phone`);
  await page.waitForSelector('input[type=url]'); // the phone screen is lazy-loaded
  await page.type('input[type=url]', SIP.server);
  await page.type('input[autocomplete=username]', SIP.username);
  await page.type('input[type=password]', 'wrong-password');
  await clickButton(page, 'Save and connect');
  await waitForText(page, '.message', 'rejected');
  check('wrong password is reported as rejected credentials', true);

  await clickButton(page, 'Settings');
  await replaceInput(page, 'input[type=password]', SIP.password);
  await clickButton(page, 'Save and connect');
  await waitForStatus(page, 'Ready');
  check('registers over WebSocket once the password is fixed', true);
  check('PBX lists the browser as a contact', asterisk('pjsip show contacts').includes('webrtc1/'));

  // --- Outgoing call, audio, mute, hang up ---------------------------------
  await replaceInput(page, '.phone-form input', '');
  for (const key of '600') await clickButton(page, key); // dialpad
  await clickButton(page, 'Call');
  await waitForStatus(page, 'On a call with 600');
  check('outgoing call (dialled on the dialpad) is answered', true);
  check('audio flows both ways through the PBX', await audioFlowsBothWays(page));

  await clickButton(page, 'Mute');
  const micOff = await page.evaluate(() =>
    window.__peerConnections
      .at(-1)
      .getSenders()
      .every((s) => s.track?.enabled === false),
  );
  await clickButton(page, 'Unmute');
  check('mute disables the outgoing track', micOff);

  await clickButton(page, 'Hang up');
  await waitForStatus(page, 'Ready');
  check('hang up returns to Ready', true);
  check('PBX channel released after hang up', await channelsReleased());

  // --- DTMF + far-end hang up ------------------------------------------------
  // Pressed back to back, like someone typing a PIN.
  await dial(page, '700');
  await waitForStatus(page, 'On a call with 700');
  await sleep(500);
  for (const key of '1234') await clickButton(page, key);
  // The IVR hangs up after four digits.
  await waitForStatus(page, 'Ready');
  check('far-end hang up returns to Ready', true);
  const digits = asterisk('database get test dtmf');
  check(`PBX received all four DTMF digits (got: ${digits.trim()})`, digits.includes('1234'));

  // --- Failure and cancel ---------------------------------------------------
  await dial(page, '486');
  await waitForText(page, '.message', 'Busy');
  check('busy number reports "Busy."', true);

  await dial(page, '601');
  await waitForStatus(page, 'Calling 601');
  await sleep(1000);
  await clickButton(page, 'Cancel');
  await waitForStatus(page, 'Ready');
  check('cancelling a ringing call shows no error', (await message(page)) === '');
  check('PBX channel released after cancel', await channelsReleased());

  // --- Incoming calls -------------------------------------------------------
  originateToBrowser();
  await waitForStatus(page, 'Incoming call from');
  check('incoming call is shown', true);
  check('tab title flags the incoming call', (await page.title()).startsWith('Incoming call'));
  await clickButton(page, 'Answer');
  await waitForStatus(page, 'On a call with');
  check('answered incoming call has audio both ways', await audioFlowsBothWays(page));
  await clickButton(page, 'Hang up');
  await waitForStatus(page, 'Ready');
  check('PBX channel released after hanging up an incoming call', await channelsReleased());

  originateToBrowser();
  await waitForStatus(page, 'Incoming call from');
  await clickButton(page, 'Decline');
  await waitForStatus(page, 'Ready');
  check('declining shows no missed-call message', (await message(page)) === '');
  check('PBX channel released after decline', await channelsReleased());

  originateToBrowser();
  await waitForStatus(page, 'Incoming call from');
  asterisk('channel request hangup all'); // caller gives up
  await waitForText(page, '.message', 'Missed call');
  check('caller hanging up first shows a missed call', true);

  // --- Leaving --------------------------------------------------------------
  await page.close({ runBeforeUnload: true });
  check(
    'closing the tab un-registers from the PBX',
    await waitFor(() => !asterisk('pjsip show contacts').includes('webrtc1/')),
  );
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
console.log('\nEnd-to-end softphone test passed.');
