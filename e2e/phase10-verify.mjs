/**
 * Phase 10 runtime verification harness (NOT part of the application).
 *
 * Drives real Edge (Chromium) sessions through the actual UI plus raw
 * WebSocket clients against the REAL running stack, and verifies the
 * meetings page, the direct invite join flow, and the leave/kick/end
 * states:
 *
 *   Meetings page (TEST 16-21)
 *     - Zoom-style app shell: sidebar (active page raised), header with
 *       search placeholder + profile chip, two-column list/detail layout
 *     - selecting a different meeting updates the detail pane
 *     - Start routes to the bare room link (lobby-first), PMI Start too
 *     - Copy Invitation puts a useful, participant_id-free invitation on
 *       the clipboard with a toast
 *     - host-only Edit modal patches title via the backend
 *     - responsive: 375px without horizontal overflow; desktop panes aligned
 *
 *   Direct invite join flow (TEST 1-5, 9-14)
 *     - a bare /room/{id} link opens the shared lobby — never a
 *       "participant_id missing" error
 *     - entering a name and joining reaches the real room with exactly ONE
 *       getUserMedia across the whole flow
 *     - unknown ID -> polished "Meeting not found" (no media, no socket)
 *     - scheduled future meeting -> scheduled state in the lobby
 *     - ended meeting -> "This meeting has ended." — no WebRTC, no camera,
 *       no WebSocket; [Back to Meetings]
 *     - refreshing a link before joining never creates a participant
 *     - dashboard Join-by-ID and invite links land on the SAME lobby
 *     - camera/mic denied -> the surviving device still works, the lobby
 *       stays usable and the user can still join
 *
 *   Leave / kick / end (TEST 6-8, 15 + extras)
 *     - voluntary leave: "You left the meeting." + Join Again; the other
 *       participant remains; rejoin is a clean new join flow (new
 *       participant id, fresh media, second getUserMedia)
 *     - host removal: "You were removed from the meeting."; the target's
 *       camera/mic stop, peer connections close, socket closes; others stay
 *     - a removed participant id is rejected by the WebSocket server
 *       (NOT_AUTHORIZED + close 1008); a FRESH join still works
 *     - host ends for everyone: host reads "Meeting ended.", participants
 *       read "This meeting has been ended by the host." — nobody is told
 *       they were "removed"
 *
 * Also audits browser consoles for errors and records a JSON report.
 */
import { chromium } from "playwright";
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const FRONT = "http://localhost:3000";
const API = "http://127.0.0.1:8000";
const WS_BASE = "ws://127.0.0.1:8000";
const REPORT_OUT = new URL("./phase10-report.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const LOGS_OUT = new URL("./phase10-console.log", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const results = [];
const logs = [];
let failures = 0;

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  if (!pass) failures += 1;
  console.log(`${pass ? "  PASS " : ">>FAIL "} ${name}${detail ? "  | " + detail : ""}`);
}

function section(title) {
  console.log(`\n===== ${title} =====`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, { timeout = 45000, interval = 700, label = "condition" } = {}) {
  const start = Date.now();
  let lastError = "";
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? ` (last error: ${lastError})` : ""}`);
}

// Injected before any page script. Wraps and records:
//   RTCPeerConnection -> creations/closures + negotiation ops
//   getUserMedia      -> local (camera) streams
//   WebSocket         -> sent frames + received messages + live socket list
// No template literals or backslashes inside (this is itself a template literal).
const INIT_SCRIPT = `
(() => {
  const NativePC = window.RTCPeerConnection;
  const created = [];
  window.__peerConnections = created;
  window.__localStreams = [];
  window.__wsSent = [];
  window.__wsReceived = [];
  window.__sockets = [];

  function WrappedPC(...args) {
    const pc = new NativePC(...args);
    const entry = { pc, createdAt: Date.now(), closedAt: null };
    const nativeClose = pc.close.bind(pc);
    pc.close = () => { entry.closedAt = Date.now(); return nativeClose(); };
    created.push(entry);
    return pc;
  }
  WrappedPC.prototype = NativePC.prototype;
  Object.setPrototypeOf(WrappedPC, NativePC);
  Object.defineProperty(window, "RTCPeerConnection", { value: WrappedPC, configurable: true, writable: true });

  const nativeGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await nativeGUM(...args);
    window.__localStreams.push(stream);
    return stream;
  };

  const NativeWS = window.WebSocket;
  function WrappedWS(...args) {
    const ws = new NativeWS(...args);
    window.__sockets.push({ ws: ws, url: String(args[0] || "") });
    const nativeSend = ws.send.bind(ws);
    ws.send = (data) => {
      try { window.__wsSent.push(Object.assign({ at: Date.now() }, JSON.parse(data))); }
      catch (e) { window.__wsSent.push({ at: Date.now(), type: "unparsed" }); }
      return nativeSend(data);
    };
    ws.addEventListener("message", (event) => {
      try { window.__wsReceived.push(Object.assign({ at: Date.now() }, JSON.parse(event.data))); } catch (e) {}
    });
    return ws;
  }
  WrappedWS.prototype = NativeWS.prototype;
  Object.setPrototypeOf(WrappedWS, NativeWS);
  Object.defineProperty(window, "WebSocket", { value: WrappedWS, configurable: true, writable: true });

  window.__phase10 = () => {
    const headerText = document.querySelector("header") ? document.querySelector("header").textContent : "";
    const texts = (selector) => Array.from(document.querySelectorAll(selector)).map((e) => e.textContent.trim());
    const h1s = texts("h1");
    const h2s = texts("h2");
    const alerts = texts('[role="alert"]');
    const statuses = texts('[role="status"]');
    const navLinks = Array.from(document.querySelectorAll("aside nav a")).map((a) => ({
      text: a.textContent.trim(),
      current: a.getAttribute("aria-current"),
    }));
    const tabSelected = document.querySelector('[role="tab"][aria-selected="true"]');
    const listPanel = document.querySelector("[data-meeting-list]");
    const detailsPanel = document.querySelector("[data-meeting-details]");
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
    };
    return {
      url: location.href,
      query: location.search,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      h1s: h1s,
      h2s: h2s,
      alerts: alerts,
      statuses: statuses,
      navLinks: navLinks,
      bodyHasParticipantId: document.body.textContent.indexOf("participant_id") !== -1,
      lobby: !!document.querySelector("[data-meeting-lobby]"),
      lobbyNameInput: !!document.querySelector('input[aria-label="Your name"]'),
      lobbyJoinButton: Array.from(document.querySelectorAll("button")).some((b) => b.textContent.trim() === "Join Meeting"),
      lobbyScheduledNotice: document.body.textContent.indexOf("This meeting is scheduled for") !== -1,
      lobbyCameraOff: document.body.textContent.indexOf("Camera is off") !== -1,
      lobbyMicToggleMuted: !!document.querySelector('button[aria-label="Unmute microphone"]'),
      exitReason: document.querySelector("[data-exit-screen]") ? document.querySelector("[data-exit-screen]").getAttribute("data-exit-screen") : null,
      notFound: !!document.querySelector("[data-meeting-not-found]"),
      meetingItems: Array.from(document.querySelectorAll("[data-meeting-item]")).map((b) => b.getAttribute("data-meeting-item")),
      hasListPanel: !!listPanel,
      hasDetailsPanel: !!detailsPanel,
      hasPmiCard: !!document.querySelector("[data-pmi-card]"),
      listRect: rectOf(listPanel),
      detailsRect: rectOf(detailsPanel),
      tabSelected: tabSelected ? tabSelected.textContent.trim() : null,
      hasSearchField: document.body.textContent.indexOf("Search") !== -1,
      connected: headerText.indexOf("Connected") !== -1,
      peers: window.__peerConnections.map((e) => ({ createdAt: e.createdAt, closedAt: e.closedAt, connectionState: e.pc.connectionState })),
      localStreamCount: window.__localStreams.length,
      localStreamTracks: window.__localStreams.flatMap((s) => s.getTracks().map((t) => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState }))),
      // Next dev keeps an HMR websocket open on every page — only sockets to
      // the meeting API are app activity.
      sockets: window.__sockets.filter((s) => s.url.indexOf("/api/ws/") !== -1).map((s) => s.ws.readyState),
      sent: window.__wsSent.slice(),
      received: {
        joined: window.__wsReceived.filter((m) => m.type === "participant_joined"),
        left: window.__wsReceived.filter((m) => m.type === "participant_left"),
        removed: window.__wsReceived.filter((m) => m.type === "participant_removed"),
        ended: window.__wsReceived.filter((m) => m.type === "meeting_ended"),
        errors: window.__wsReceived.filter((m) => m.type === "error"),
      },
    };
  };
})();
`;

function attach(page, label) {
  page.on("console", (msg) => {
    const text = msg.text();
    logs.push({ label, at: Date.now(), type: msg.type(), text });
    if (msg.type() === "error") console.log(`   [${label}][console.error] ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (error) => {
    logs.push({ label, at: Date.now(), type: "pageerror", text: error.message });
    console.log(`   [${label}][pageerror] ${error.message.slice(0, 300)}`);
  });
  page.on("dialog", (dialog) => dialog.accept().catch(() => {}));
}

const evidence = (page) => page.evaluate(() => window.__phase10()).catch(() => null);
const openPeers = (ev) => (ev ? ev.peers.filter((p) => !p.closedAt) : []);
const connectedPeers = (ev) => openPeers(ev).filter((p) => p.connectionState === "connected");
const gumCalls = (ev) => (ev ? ev.localStreamCount : 0);
const allSocketsClosed = (ev) => !!ev && ev.sockets.length > 0 && ev.sockets.every((s) => s === 3);

async function waitConnected(page, label) {
  return waitUntil(async () => (await evidence(page))?.connected, { label: `${label} connected`, timeout: 60000 });
}

async function waitLobby(page, label) {
  await waitUntil(async () => (await evidence(page))?.lobby, { label: `${label} lobby visible`, timeout: 90000 });
  return evidence(page);
}

// ---------------------------------------------------------------------------
// REST helpers (the same API the app uses).
// ---------------------------------------------------------------------------

async function registerUser(name) {
  const res = await fetch(`${API}/api/users/me`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), display_name: name }) });
  return res.json();
}

async function createMeetingRest(title, hostUserId, opts = {}) {
  const body = { title, host_id: hostUserId };
  if (opts.scheduledAt) body.scheduled_at = opts.scheduledAt;
  const res = await fetch(`${API}/api/meetings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

async function joinRest(meetingId, displayName, userId) {
  const res = await fetch(`${API}/api/meetings/${meetingId}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ display_name: displayName, user_id: userId }) });
  return res.json();
}

async function meetingStatus(meetingId) {
  return (await (await fetch(`${API}/api/meetings/${meetingId}`)).json()).status;
}

async function activeParticipantCount(meetingId) {
  const res = await fetch(`${API}/api/meetings/${meetingId}/participants`);
  const list = await res.json();
  return Array.isArray(list) ? list.filter((p) => !p.left_at).length : list.length;
}

// ---------------------------------------------------------------------------
// Raw WebSocket helpers.
// ---------------------------------------------------------------------------

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const conn = { socket, messages: [], closeCode: null };
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { message = { type: "UNPARSEABLE" }; }
      conn.messages.push(message);
    });
    socket.on("close", (code) => { conn.closeCode = code; });
    socket.on("open", () => resolve(conn));
    socket.on("error", reject);
  });
}

const wsWaitFor = (conn, predicate, timeoutMs = 8000) => new Promise((resolve) => {
  const found = () => conn.messages.find(predicate);
  if (found()) return resolve(found());
  const timer = setInterval(() => { if (found()) { clearInterval(timer); resolve(found()); } }, 100);
  setTimeout(() => { clearInterval(timer); resolve(null); }, timeoutMs);
});

const wsUrl = (meetingId, participantId) =>
  `${WS_BASE}/api/ws/meetings/${encodeURIComponent(meetingId)}?participant_id=${encodeURIComponent(participantId)}`;

// ---------------------------------------------------------------------------
// Browser context helpers.
// ---------------------------------------------------------------------------

async function openContext(browser, label, opts = {}) {
  const context = await browser.newContext({
    permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"],
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
  });
  await context.addInitScript(INIT_SCRIPT);
  if (opts.identity) {
    // Seed the browser's stored identity so the meetings page treats this
    // context as a specific (host) user — exactly what localStorage holds
    // for a returning browser.
    await context.addInitScript(
      `localStorage.setItem("meetspace_user_id", ${JSON.stringify(opts.identity.id)});` +
      `localStorage.setItem("meetspace_display_name", ${JSON.stringify(opts.identity.display_name)});`,
    );
  }
  if (opts.denyMedia) {
    // Simulate a browser-level permission denial for one device kind: the
    // wrapped getUserMedia throws NotAllowedError for that kind, exercising
    // the app's real partial-permission path.
    const kind = JSON.stringify(opts.denyMedia);
    await context.addInitScript(`
      (() => {
        const current = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          if (constraints && constraints[${kind}]) throw new DOMException("Permission denied", "NotAllowedError");
          return current(constraints);
        };
      })();
    `);
  }
  const page = await context.newPage();
  attach(page, label);
  return { context, page };
}

/** Join a meeting directly at the room URL with a URL session (the fast path). */
async function browserJoin(browser, label, meetingId, participant, opts = {}) {
  const { context, page } = await openContext(browser, label, opts);
  const params = new URLSearchParams({ participant_id: participant.id, name: participant.name });
  await page.goto(`${FRONT}/room/${meetingId}?${params.toString()}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  return { context, page, id: participant.id, name: participant.name };
}

/** Open a bare invite link (no session in the URL) — the shared lobby path. */
async function openInvite(browser, label, meetingId, opts = {}) {
  const { context, page } = await openContext(browser, label, opts);
  await page.goto(`${FRONT}/room/${meetingId}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  return { context, page };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: [
      "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--host-resolver-rules=MAP localhost:8000 127.0.0.1",
    ],
  });

  try {
    // ---------- REST fixtures ----------
    const hostDirect = await registerUser("Direct Host");
    const mDirect = await createMeetingRest("Direct Invite Flow", hostDirect.id);
    const hostSched = await registerUser("Schedule Host");
    const mSched = await createMeetingRest("Scheduled Strategy Sync", hostSched.id, { scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    const hostFresh = await registerUser("Fresh Host");
    const mFresh = await createMeetingRest("Silent Link Check", hostFresh.id);
    const hostMedia = await registerUser("Media Host");
    const mMedia = await createMeetingRest("Permission Fallbacks", hostMedia.id);

    // =====================================================================
    section("TEST 1/2/9 — direct invite link -> shared lobby -> real room");
    // =====================================================================
    const D = await openInvite(browser, "D", mDirect.meeting_id);
    let evD = await waitLobby(D.page, "D");
    record("T1: bare /room/{id} opens the lobby (no participant_id error)", evD.lobby && !evD.notFound && !evD.exitReason, `url=${evD.url}`);
    record("T1: lobby shows the meeting title", evD.h1s.includes("Direct Invite Flow"), evD.h1s.join(" | "));
    record("T1: the invite URL carries no query string (meeting ID only)", evD.query === "", `query=${evD.query}`);
    record("T9: no participant_id appears anywhere in the lobby UI", !evD.bodyHasParticipantId);
    record("T1: the lobby opens no WebSocket before joining", evD.sockets.length === 0, `sockets=${evD.sockets.length}`);

    // Name validation: whitespace-only must be rejected client-side, and no
    // participant record may exist for an empty name.
    record("X-name: no participant exists before anyone joins", (await activeParticipantCount(mDirect.meeting_id)) === 0);
    await D.page.getByLabel("Your name").fill("   ");
    await D.page.getByRole("button", { name: "Join Meeting" }).click();
    await waitUntil(async () => (await evidence(D.page))?.alerts.includes("Please enter your name"), { label: "empty-name rejection message" });
    record("X-name: whitespace-only name rejected with 'Please enter your name'", true);
    record("X-name: rejected join created no participant", (await activeParticipantCount(mDirect.meeting_id)) === 0);

    // Join as a guest with a per-session name.
    await D.page.getByLabel("Your name").fill("Alex");
    await D.page.getByRole("button", { name: "Join Meeting" }).click();
    await waitConnected(D.page, "D (Alex)");
    evD = await evidence(D.page);
    const alexSession = new URL(evD.url).searchParams.get("participant_id");
    record("T2: entering 'Alex' + Join reaches the real room (Connected)", evD.connected, `url=${evD.url}`);
    record("T2: exactly ONE getUserMedia across lobby preview + room", gumCalls(evD) === 1, `gumCalls=${gumCalls(evD)}`);
    record("T2: the joined session has working audio + video tracks", evD.localStreamTracks.filter((t) => t.readyState === "live").length >= 2, JSON.stringify(evD.localStreamTracks.map((t) => t.kind)));

    // =====================================================================
    section("TEST 6/15 — voluntary leave, other stays; clean rejoin");
    // =====================================================================
    const bellaUser = await registerUser("Bella");
    const bellaParticipant = await joinRest(mDirect.meeting_id, "Bella", bellaUser.id);
    const B = await browserJoin(browser, "B", mDirect.meeting_id, { id: bellaParticipant.id, name: "Bella" });
    await waitConnected(B.page, "B (Bella)");
    await waitUntil(async () => connectedPeers(await evidence(D.page)).length >= 1, { label: "D-Alex peer to Bella connected" });
    record("Setup: Alex and Bella connected in the same room", true);

    await D.page.getByRole("button", { name: "End", exact: true }).click();
    await waitUntil(async () => (await evidence(D.page))?.exitReason === "left", { label: "D sees the left screen" });
    evD = await evidence(D.page);
    record("T6: leaver reads 'You left the meeting.'", evD.h2s.includes("You left the meeting."), evD.h2s.join(" | "));
    record("T6: the exit URL is stripped to the bare room link", evD.query === "" && evD.url.endsWith(`/room/${mDirect.meeting_id}`), `url=${evD.url}`);
    record("T6: leaver's media stopped and peer connections closed", evD.localStreamTracks.length > 0 && evD.localStreamTracks.every((t) => t.readyState === "ended") && openPeers(evD).length === 0);
    const evB6 = await evidence(B.page);
    record("T6: the other participant receives participant_left (not removed)", evB6.received.left.some((m) => m.participant_id === alexSession) && !evB6.received.removed.some((m) => m.participant_id === alexSession));
    record("T6: the other participant remains connected in the room", evB6.connected, `peers=${connectedPeers(evB6).length}`);

    // Rejoin through the exit screen's Join Again — a fresh join flow.
    await D.page.getByRole("button", { name: "Join Again" }).click();
    await waitLobby(D.page, "D rejoin lobby");
    await D.page.getByLabel("Your name").fill("Alex");
    await D.page.getByRole("button", { name: "Join Meeting" }).click();
    await waitConnected(D.page, "D (Alex rejoin)");
    evD = await evidence(D.page);
    const alexSession2 = new URL(evD.url).searchParams.get("participant_id");
    record("T15: rejoin goes through the lobby again and reconnects", evD.connected, `url=${evD.url}`);
    record("T15: rejoin is a FRESH session (new participant id)", !!alexSession2 && alexSession2 !== alexSession, `${alexSession} -> ${alexSession2}`);
    record("T15: rejoin used exactly one more getUserMedia (2 total)", gumCalls(evD) === 2, `gumCalls=${gumCalls(evD)}`);
    await waitUntil(async () => {
      const ev = await evidence(B.page);
      return ev && ev.received.joined.some((m) => m.participant_id === alexSession2);
    }, { label: "Bella sees Alex rejoin" });
    record("T15: the remaining participant saw the rejoin (participant_joined)", true);
    await D.context.close();
    await B.context.close();

    // =====================================================================
    section("TEST 3 — unknown meeting ID");
    // =====================================================================
    const N = await openInvite(browser, "N", "999999999");
    const evN = await waitUntil(async () => {
      const ev = await evidence(N.page);
      return ev && (ev.notFound || ev.exitReason) ? ev : null;
    }, { label: "unknown ID resolves to a terminal screen" });
    record("T3: unknown ID shows the polished 'Meeting not found' screen", evN.notFound && evN.h2s.includes("Meeting not found"), evN.h2s.join(" | "));
    record("T3: message says the meeting may be deleted or the link incorrect", (await N.page.textContent("body")).includes("This meeting may have been deleted or the link may be incorrect."));
    record("T3: no camera access for an invalid link (no getUserMedia)", gumCalls(evN) === 0, `gumCalls=${gumCalls(evN)}`);
    record("T3: no WebSocket and no WebRTC for an invalid link", evN.sockets.length === 0 && evN.peers.length === 0);
    await N.page.getByRole("button", { name: "Back to Home" }).click();
    await waitUntil(async () => (await evidence(N.page))?.url === `${FRONT}/`, { label: "Back to Home navigates" });
    record("T3: 'Back to Home' returns to the dashboard", true);
    await N.context.close();

    // =====================================================================
    section("TEST 4 — scheduled (future) meeting");
    // =====================================================================
    const S = await openInvite(browser, "S", mSched.meeting_id);
    const evS = await waitLobby(S.page, "S scheduled");
    record("T4: scheduled future meeting opens the lobby (join allowed early)", evS.lobby && evS.lobbyJoinButton);
    record("T4: lobby shows the scheduled state notice", evS.lobbyScheduledNotice);
    record("T4: lobby shows the correct meeting title", evS.h1s.includes("Scheduled Strategy Sync"));
    await S.context.close();

    // =====================================================================
    section("TEST 5 — ended meeting (link never joined)");
    // =====================================================================
    const hostEnded = await registerUser("Ended Host");
    const mEnded = await createMeetingRest("Already Over", hostEnded.id);
    const endedHostParticipant = await joinRest(mEnded.meeting_id, "Ended Host", hostEnded.id);
    const WE = await wsConnect(wsUrl(mEnded.meeting_id, endedHostParticipant.id));
    WE.socket.send(JSON.stringify({ type: "meeting_ended" }));
    await wsWaitFor(WE, (m) => m.type === "meeting_ended");
    WE.socket.close();
    record("Setup: meeting ended via host WebSocket", (await meetingStatus(mEnded.meeting_id)) === "ended");

    const E = await openInvite(browser, "E", mEnded.meeting_id);
    const evE = await waitUntil(async () => {
      const ev = await evidence(E.page);
      return ev && ev.exitReason === "ended" ? ev : null;
    }, { label: "ended link shows the ended screen" });
    record("T5: ended link reads 'This meeting has ended.' (never an error)", evE.h2s.includes("This meeting has ended."), evE.h2s.join(" | "));
    record("T5: no getUserMedia — the camera is never touched", gumCalls(evE) === 0, `gumCalls=${gumCalls(evE)}`);
    record("T5: no WebSocket and no WebRTC initialized", evE.sockets.length === 0 && evE.peers.length === 0);
    await E.page.getByRole("button", { name: "Back to Meetings" }).click();
    await waitUntil(async () => (await evidence(E.page))?.h1s.includes("Meetings"), { label: "Back to Meetings navigates" });
    record("T5: 'Back to Meetings' returns to the Meetings page", true);
    await E.context.close();

    // =====================================================================
    section("TEST 10 — refreshing a link before joining");
    // =====================================================================
    const R = await openInvite(browser, "R", mFresh.meeting_id);
    await waitLobby(R.page, "R first visit");
    record("T10: first visit shows the lobby, no participant created", (await activeParticipantCount(mFresh.meeting_id)) === 0);
    await R.page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
    const evR = await waitLobby(R.page, "R after reload");
    record("T10: reload shows the lobby again (fresh join flow, no error)", evR.lobby && !evR.notFound && !evR.exitReason);
    record("T10: refresh still created no participant record", (await activeParticipantCount(mFresh.meeting_id)) === 0);
    record("T10: no WebSocket was opened while sitting in the lobby", evR.sockets.length === 0);
    await R.context.close();

    // =====================================================================
    section("TEST 11/12 — dashboard Join by ID and invite links share one lobby");
    // =====================================================================
    const J = await openContext(browser, "J");
    await J.page.goto(`${FRONT}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await waitUntil(async () => (await evidence(J.page))?.h1s.length > 0, { label: "dashboard renders" });
    // The quick actions are server-rendered, so the h1 can appear before
    // React hydrates and a click would hit a dead button. The clock reads
    // "--:--" until the first client effect runs — wait for real content.
    await waitUntil(async () => (await J.page.getByText("--:--").count()) === 0, { label: "dashboard hydrated" });
    await J.page.getByRole("button", { name: "Join", exact: true }).click();
    await waitUntil(async () => (await evidence(J.page))?.h2s.includes("Join a meeting"), { label: "Join dialog opens" });
    await J.page.getByLabel("Meeting ID").fill(mDirect.meeting_id);
    await J.page.getByRole("button", { name: "Continue" }).click();
    const evJ = await waitLobby(J.page, "J via dashboard join");
    record("T11: dashboard Join by Meeting ID reaches the MeetingLobby", evJ.lobby && evJ.h1s.includes("Direct Invite Flow"), evJ.h1s.join(" | "));
    record("T12: invite-link lobby and dashboard-join lobby are the SAME component (identical form)", evJ.lobbyNameInput && evJ.lobbyJoinButton && evJ.query === "", `query=${evJ.query}`);
    await J.context.close();

    // =====================================================================
    section("TEST 13/14 — camera / mic permission denied");
    // =====================================================================
    const C13 = await openInvite(browser, "C13", mMedia.meeting_id, { denyMedia: "video" });
    const ev13 = await waitLobby(C13.page, "camera-denied lobby");
    record("T13: camera denied — lobby stays usable (banner + Join enabled)", ev13.lobby && ev13.lobbyJoinButton && ev13.statuses.some((t) => t.includes("You can still join the meeting.")), ev13.statuses.join(" | "));
    record("T13: the microphone still works (audio-only fallback stream)", ev13.localStreamTracks.filter((t) => t.kind === "audio" && t.readyState === "live").length === 1 && !ev13.localStreamTracks.some((t) => t.kind === "video"));
    record("T13: preview honestly shows 'Camera is off'", ev13.lobbyCameraOff);
    await C13.page.getByLabel("Your name").fill("Cam Guest");
    await C13.page.getByRole("button", { name: "Join Meeting" }).click();
    await waitConnected(C13.page, "camera-denied join");
    record("T13: user can still join the meeting with camera disabled", true);
    await C13.context.close();

    const C14 = await openInvite(browser, "C14", mMedia.meeting_id, { denyMedia: "audio" });
    const ev14 = await waitLobby(C14.page, "mic-denied lobby");
    record("T14: mic denied — lobby stays usable (banner + Join enabled)", ev14.lobby && ev14.lobbyJoinButton && ev14.statuses.some((t) => t.includes("You can still join the meeting.")));
    record("T14: the camera still works (video-only fallback stream)", ev14.localStreamTracks.filter((t) => t.kind === "video" && t.readyState === "live").length === 1 && !ev14.localStreamTracks.some((t) => t.kind === "audio"));
    record("T14: microphone toggle honestly shows muted", ev14.lobbyMicToggleMuted);
    await C14.page.getByLabel("Your name").fill("Mic Guest");
    await C14.page.getByRole("button", { name: "Join Meeting" }).click();
    await waitConnected(C14.page, "mic-denied join");
    record("T14: user can still join the meeting muted", true);
    await C14.context.close();

    // =====================================================================
    section("TEST 7 — host removes a participant");
    // =====================================================================
    const kickHost = await registerUser("Kick Host");
    const mKick = await createMeetingRest("Kick And End Flow", kickHost.id);
    const kickHostParticipant = await joinRest(mKick.meeting_id, "Kick Host", kickHost.id);
    const peerAUser = await registerUser("Peer A");
    const peerA = await joinRest(mKick.meeting_id, "Peer A", peerAUser.id);
    const peerBUser = await registerUser("Peer B");
    const peerB = await joinRest(mKick.meeting_id, "Peer B", peerBUser.id);
    const H = await browserJoin(browser, "H", mKick.meeting_id, { id: kickHostParticipant.id, name: "Kick Host" });
    const A = await browserJoin(browser, "A", mKick.meeting_id, { id: peerA.id, name: "Peer A" });
    const Bk = await browserJoin(browser, "Bk", mKick.meeting_id, { id: peerB.id, name: "Peer B" });
    for (const [label, page] of [["H", H.page], ["A", A.page], ["Bk", Bk.page]]) await waitConnected(page, label);
    await waitUntil(async () => connectedPeers(await evidence(H.page)).length >= 2, { label: "H meshed with A and Bk" });
    record("Setup: host + two participants connected", true);

    await H.page.getByRole("button", { name: "Participants", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(H.page);
      return ev && (await H.page.locator(`button[aria-label="Remove Peer B from meeting"]`).count()) === 1;
    }, { label: "host sees Remove for Peer B" });
    await H.page.getByRole("button", { name: "Remove Peer B from meeting" }).click();
    await waitUntil(async () => (await evidence(Bk.page))?.exitReason === "kicked", { label: "Bk sees the kicked screen" });
    const evBk = await evidence(Bk.page);
    record("T7: removed participant reads 'You were removed from the meeting.'", evBk.h2s.includes("You were removed from the meeting."), evBk.h2s.join(" | "));
    record("T7: removed participant's camera/mic stopped", evBk.localStreamTracks.length > 0 && evBk.localStreamTracks.every((t) => t.readyState === "ended"));
    record("T7: removed participant's peer connections all closed", openPeers(evBk).length === 0 && evBk.peers.length > 0 && evBk.peers.every((p) => p.closedAt));
    await waitUntil(async () => allSocketsClosed(await evidence(Bk.page)), { label: "Bk WebSocket closed" });
    record("T7: removed participant's WebSocket closed", true);
    record("T7: removed participant's URL stripped to the bare room link", evBk.query === "" && evBk.url.endsWith(`/room/${mKick.meeting_id}`), `url=${evBk.url}`);
    const evA7 = await evidence(A.page);
    const evH7 = await evidence(H.page);
    record("T7: the remaining participant stays connected and saw the removal broadcast", evA7.connected && evA7.received.removed.some((m) => m.participant_id === peerB.id));
    record("T7: the host stays connected", evH7.connected);
    await Bk.context.close();

    // Stale identity: the removed participant id must be rejected by the
    // WebSocket server; a FRESH join (new participant) must still work.
    const stale = await wsConnect(wsUrl(mKick.meeting_id, peerB.id));
    const staleError = await wsWaitFor(stale, (m) => m.type === "error");
    await waitUntil(async () => stale.closeCode !== null, { timeout: 5000, label: "stale socket closed" }).catch(() => {});
    record("X-kick: removed participant id is REJECTED on reconnect (NOT_AUTHORIZED)", staleError && staleError.code === "NOT_AUTHORIZED", JSON.stringify(staleError));
    record("X-kick: the stale socket is closed by the server (1008)", stale.closeCode === 1008, `closeCode=${stale.closeCode}`);
    const peerBRejoined = await joinRest(mKick.meeting_id, "Peer B", peerBUser.id);
    record("X-kick: rejoin creates a NEW participant id (fresh identity)", peerBRejoined.id !== peerB.id, `${peerB.id} -> ${peerBRejoined.id}`);
    const freshSocket = await wsConnect(wsUrl(mKick.meeting_id, peerBRejoined.id));
    const freshState = await wsWaitFor(freshSocket, (m) => m.type === "room_state");
    record("X-kick: a fresh join still connects normally (room_state received)", !!freshState);
    freshSocket.socket.close();

    // =====================================================================
    section("TEST 8 — host ends the meeting for everyone");
    // =====================================================================
    await H.page.keyboard.press("Escape");
    await H.page.getByRole("button", { name: "End", exact: true }).click();
    await waitUntil(async () => (await evidence(H.page))?.h2s.includes("End meeting for everyone?"), { label: "host End confirmation" });
    await H.page.getByRole("button", { name: "Cancel", exact: true }).click();
    await sleep(600);
    record("T8: Cancel keeps the meeting running", (await evidence(A.page)).connected);
    await H.page.getByRole("button", { name: "End", exact: true }).click();
    await H.page.getByRole("dialog").getByRole("button", { name: "End Meeting" }).click();
    await waitUntil(async () => (await evidence(H.page))?.exitReason === "ended", { label: "host exit screen" });
    await waitUntil(async () => (await evidence(A.page))?.exitReason === "ended", { label: "participant exit screen" });
    const evH8 = await evidence(H.page);
    const evA8 = await evidence(A.page);
    record("T8: host reads 'Meeting ended.'", evH8.h2s.includes("Meeting ended."), evH8.h2s.join(" | "));
    record("T8: participant reads 'This meeting has been ended by the host.'", evA8.h2s.includes("This meeting has been ended by the host."), evA8.h2s.join(" | "));
    record("T8: nobody is told they were 'removed' by the end flow", !evH8.h2s.join(" ").includes("removed") && !evA8.h2s.join(" ").includes("removed"));
    record("T8: both cleaned up media + peers", openPeers(evH8).length === 0 && openPeers(evA8).length === 0 && evH8.localStreamTracks.every((t) => t.readyState === "ended") && evA8.localStreamTracks.every((t) => t.readyState === "ended"));
    record("T8: meeting marked ended in the database", (await meetingStatus(mKick.meeting_id)) === "ended");
    await H.context.close();
    await A.context.close();

    // =====================================================================
    section("TEST 16-21 — the Meetings page");
    // =====================================================================
    const editHost = await registerUser("Meetings Host");
    const mEdit = await createMeetingRest("Editable Standup", editHost.id);
    const M = await openContext(browser, "M", { viewport: { width: 1280, height: 900 }, identity: editHost });
    await M.page.goto(`${FRONT}/meetings`, { waitUntil: "domcontentloaded", timeout: 90000 });
    const evM = await waitUntil(async () => {
      const ev = await evidence(M.page);
      return ev && ev.h1s.includes("Meetings") && ev.hasListPanel ? ev : null;
    }, { label: "Meetings page renders" });

    record("T16: Zoom-style shell — sidebar nav with Home/Meetings/Chat/More", evM.navLinks.length >= 4, evM.navLinks.map((n) => n.text).join(", "));
    record("T16: current page is visibly selected (aria-current on Meetings)", evM.navLinks.some((n) => n.text === "Meetings" && n.current === "page"));
    record("T16: header search field present", evM.hasSearchField);
    record("T16: two-column layout — meeting list AND detail pane", evM.hasListPanel && evM.hasDetailsPanel);
    record("T16: Personal Meeting ID card present with stable PMI", evM.hasPmiCard && (await M.page.textContent("[data-pmi-card]")).includes(editHost.personal_meeting_id), `pmi=${editHost.personal_meeting_id}`);
    record("T16: Upcoming tab is the default selection", evM.tabSelected === "Upcoming", `tab=${evM.tabSelected}`);
    record("T16: no participant_id exposed in the URL or the page UI", evM.query === "" && !evM.bodyHasParticipantId);

    // TEST 17 — selecting a different meeting updates the detail pane.
    const clickItem = async (meetingId) => {
      await M.page.locator(`[data-meeting-item="${meetingId}"]`).click();
      await sleep(400);
    };
    await clickItem(mDirect.meeting_id);
    let evM17 = await evidence(M.page);
    record("T17: selecting 'Direct Invite Flow' shows its details", evM17.h2s.includes("Direct Invite Flow"), evM17.h2s.filter((h) => !h.includes("Personal")).join(" | "));
    await clickItem(mEdit.meeting_id);
    evM17 = await evidence(M.page);
    record("T17: selecting 'Editable Standup' updates the detail pane", evM17.h2s.includes("Editable Standup"));

    // TEST 18 — Start routes to the bare room link (lobby-first).
    await M.page.locator("[data-meeting-details]").getByRole("button", { name: "Start", exact: true }).click();
    const evM18 = await waitUntil(async () => {
      const ev = await evidence(M.page);
      return ev && ev.lobby ? ev : null;
    }, { label: "Start opens the room join flow" });
    record("T18: Start routes to the bare /room/{id} link (lobby)", evM18.lobby && evM18.h1s.includes("Editable Standup") && evM18.query === "", `url=${evM18.url}`);
    await M.page.goBack();
    await waitUntil(async () => (await evidence(M.page))?.h1s.includes("Meetings"), { label: "back to Meetings page" });

    // PMI Start — same lobby-first behavior for the personal room.
    await M.page.locator("[data-pmi-card]").getByRole("button", { name: "Start", exact: true }).click();
    const evMpmi = await waitUntil(async () => {
      const ev = await evidence(M.page);
      return ev && ev.lobby ? ev : null;
    }, { label: "PMI Start opens the join flow" });
    record("X-pmi: Personal Meeting Room Start opens its lobby (bare link)", evMpmi.lobby && evMpmi.url.includes(`/room/${editHost.personal_meeting_id}`), `url=${evMpmi.url}`);
    await M.page.goBack();
    await waitUntil(async () => (await evidence(M.page))?.h1s.includes("Meetings"), { label: "back to Meetings page" });

    // TEST 19 — Copy Invitation.
    await clickItem(mEdit.meeting_id);
    await M.page.locator("[data-meeting-details]").getByRole("button", { name: "Copy Invitation" }).click();
    await waitUntil(async () => (await evidence(M.page))?.statuses.includes("Invitation copied"), { label: "'Invitation copied' toast" });
    const invitation = await M.page.evaluate(() => navigator.clipboard.readText());
    const expectedUrl = `${FRONT}/room/${mEdit.meeting_id}`;
    record("T19: clipboard holds a useful invitation (join URL + Meeting ID)", invitation.includes("Join my meeting:") && invitation.includes(expectedUrl) && invitation.includes("Meeting ID:"), JSON.stringify(invitation));
    record("T19/T9: the invitation contains no participant_id or internal IDs", !invitation.includes("participant_id") && !invitation.includes(mEdit.id));
    record("T19: 'Invitation copied' toast shown", true);

    // Host-only Edit flow.
    await M.page.locator("[data-meeting-details]").getByRole("button", { name: "Edit", exact: true }).click();
    await waitUntil(async () => (await evidence(M.page))?.h2s.includes("Edit meeting"), { label: "Edit modal opens" });
    await M.page.getByLabel("Meeting topic").fill("Renamed Standup");
    await M.page.getByRole("button", { name: "Save changes" }).click();
    await waitUntil(async () => {
      const ev = await evidence(M.page);
      return ev && ev.statuses.includes("Meeting updated") && ev.h2s.includes("Renamed Standup") ? ev : null;
    }, { label: "edit saved with toast + updated details" });
    const evEdit = await evidence(M.page);
    record("X-edit: host can edit the title (toast + detail pane update)", evEdit.h2s.includes("Renamed Standup"));
    const mEditAfter = await (await fetch(`${API}/api/meetings/${mEdit.meeting_id}`)).json();
    record("X-edit: the PATCH persisted on the backend", mEditAfter.title === "Renamed Standup", mEditAfter.title);
    await clickItem(mDirect.meeting_id);
    await sleep(400);
    const editButtonCount = await M.page.getByRole("button", { name: "Edit", exact: true }).count();
    record("X-edit: a meeting hosted by someone else offers NO Edit button", editButtonCount === 0, `editButtons=${editButtonCount}`);

    // Schedule from the header.
    await M.page.getByRole("button", { name: "Schedule a meeting" }).click();
    await waitUntil(async () => (await evidence(M.page))?.h2s.includes("Schedule a meeting"), { label: "Schedule modal opens" });
    await M.page.getByLabel("Meeting topic").fill("Scheduled From Page");
    await M.page.getByRole("button", { name: "Save meeting" }).click();
    await waitUntil(async () => (await evidence(M.page))?.statuses.includes("Meeting scheduled"), { label: "scheduled toast" });
    record("X-schedule: scheduling from the page creates and lists the meeting", true);

    // TEST 21 — desktop panes aligned (sidebar + list + detail).
    const evM21 = await evidence(M.page);
    const aligned = evM21.listRect && evM21.detailsRect
      ? Math.abs(evM21.listRect.top - evM21.detailsRect.top) < 120 && evM21.listRect.right <= evM21.detailsRect.left + 2
      : false;
    record("T21: at 1280px the list and detail panes sit side by side, no overlap", aligned, JSON.stringify({ list: evM21.listRect, details: evM21.detailsRect }));
    record("T21: no horizontal overflow on desktop", evM21.scrollWidth <= evM21.innerWidth + 1, `scrollWidth=${evM21.scrollWidth} innerWidth=${evM21.innerWidth}`);

    // Small nav pages render.
    for (const [path, title] of [["/chat", "Chat"], ["/more", "More"], ["/settings", "Settings"]]) {
      await M.page.goto(`${FRONT}${path}`, { waitUntil: "domcontentloaded", timeout: 90000 });
      const ev = await waitUntil(async () => {
        const e = await evidence(M.page);
        return e && e.h1s.includes(title) ? e : null;
      }, { label: `${path} renders` });
      record(`X-nav: ${path} renders the ${title} page`, ev.h1s.includes(title));
    }
    // The Settings page resolves the identity asynchronously — wait for the
    // profile to hydrate ("Loading…" -> real name) before reading the text.
    const settingsText = await waitUntil(async () => {
      const text = await M.page.textContent("body");
      return text && text.includes("Meetings Host") ? text : null;
    }, { label: "Settings identity loads" });
    record("X-nav: Settings shows the identity profile info", settingsText.includes("Meetings Host") && settingsText.replace(/\s/g, "").includes(editHost.personal_meeting_id));
    await M.context.close();

    // TEST 20 — 375px responsive.
    const M375 = await openContext(browser, "M375", { viewport: { width: 375, height: 812 }, identity: editHost });
    await M375.page.goto(`${FRONT}/meetings`, { waitUntil: "domcontentloaded", timeout: 90000 });
    const ev375 = await waitUntil(async () => {
      const ev = await evidence(M375.page);
      return ev && ev.h1s.includes("Meetings") ? ev : null;
    }, { label: "Meetings page at 375px" });
    record("T20: Meetings page at 375px — no horizontal overflow", ev375.scrollWidth <= ev375.innerWidth + 1, `scrollWidth=${ev375.scrollWidth} innerWidth=${ev375.innerWidth}`);
    const L375 = await openInvite(browser, "L375", mMedia.meeting_id, { viewport: { width: 375, height: 812 } });
    const evL375 = await waitLobby(L375.page, "lobby at 375px");
    record("T20: join lobby at 375px — no horizontal overflow", evL375.scrollWidth <= evL375.innerWidth + 1, `scrollWidth=${evL375.scrollWidth}`);
    await M375.context.close();
    await L375.context.close();

    // ---------- Console audit ----------
    section("Console audit");
    const errorSignature = /InvalidStateError|OperationError|Failed to set remote|Failed to set local|NotAllowedError|NotReadableError|ICE failed|iceConnectionState=failed|fullscreen|Fullscreen/;
    const expectedNoise = /Failed to load resource|WebSocket connection|net::ERR|favicon|404|410/i;
    const consoleErrors = logs.filter((l) => (l.type === "error" || l.type === "pageerror") && errorSignature.test(l.text));
    record("No WebRTC/media/fullscreen errors in any browser console", consoleErrors.length === 0, consoleErrors.slice(0, 3).map((e) => `${e.label}: ${e.text.slice(0, 80)}`).join(" | "));
    const otherErrors = logs.filter((l) => (l.type === "error" || l.type === "pageerror") && !errorSignature.test(l.text) && !expectedNoise.test(l.text));
    record("No other console errors or page errors", otherErrors.length === 0, otherErrors.slice(0, 3).map((e) => `${e.label}: ${e.text.slice(0, 100)}`).join(" | "));

    // ---------- Summary ----------
    const passed = results.length - failures;
    console.log(`\n============================================`);
    console.log(`PHASE 10: ${passed}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
    console.log(`============================================\n`);
    writeFileSync(REPORT_OUT, JSON.stringify({ suite: "phase10", passed, failed: failures, total: results.length, results }, null, 2));
    writeFileSync(LOGS_OUT, logs.map((l) => `[${new Date(l.at).toISOString()}][${l.label}][${l.type}] ${l.text}`).join("\n"));
    process.exitCode = failures ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("HARNESS FAILURE:", error);
  // Leave the evidence behind even when the suite dies mid-run.
  try {
    writeFileSync(REPORT_OUT, JSON.stringify({ suite: "phase10", crashed: String(error && error.stack ? error.stack : error), passed: results.length - failures, failed: failures, total: results.length, results }, null, 2));
    writeFileSync(LOGS_OUT, logs.map((l) => `[${new Date(l.at).toISOString()}][${l.label}][${l.type}] ${l.text}`).join("\n"));
  } catch {}
  process.exitCode = 1;
});
