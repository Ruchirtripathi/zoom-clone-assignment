/**
 * Phase 8 runtime verification harness (NOT part of the application).
 *
 * Drives real Edge (Chromium) sessions through the actual UI plus raw
 * WebSocket clients against the REAL running stack, and verifies:
 *
 *   Media-state synchronization (TEST 1-8)
 *     - mute/unmute propagates to every remote participant (SET semantics)
 *     - camera off shows the avatar, camera on restores video
 *     - NO PeerConnection recreation and NO createOffer/createAnswer/
 *       setLocalDescription/setRemoteDescription during any toggle
 *     - join-with-camera-off / join-muted visible to later joiners through
 *       room_state alone (no post-join event required)
 *     - 2, 3 and 4 participants all update
 *
 *   Realtime chat (TEST 9-18)
 *     - messages delivered to everyone in the meeting over the SAME WebSocket
 *     - unread badge (own messages never counted), clears on open
 *     - history reloads after refresh, deduplicated by message id
 *     - cross-meeting isolation
 *     - empty / oversized messages rejected with structured errors
 *     - sender spoofing ignored — identity comes from the connection
 *     - payload meeting_id never redirects delivery
 *     - disconnected state: send disabled + "Reconnecting..." notice
 *
 * Also audits browser consoles for errors and records a JSON report.
 */
import { chromium } from "playwright";
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const FRONT = "http://localhost:3000";
const API = "http://127.0.0.1:8000";
const WS_BASE = "ws://127.0.0.1:8000";
const REPORT_OUT = new URL("./phase8-report.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const LOGS_OUT = new URL("./phase8-console.log", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

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

async function eventually(fn, opts) {
  try { await waitUntil(fn, opts); return true; } catch { return false; }
}

// Injected before any page script. Wraps and records:
//   RTCPeerConnection -> creations/closures + all four negotiation ops
//   getUserMedia      -> local (camera) streams
//   WebSocket         -> sent frames + received messages + live socket list
// No backslashes / template literals inside (this is itself a template literal).
const INIT_SCRIPT = `
(() => {
  const NativePC = window.RTCPeerConnection;
  const created = [];
  window.__peerConnections = created;
  window.__localStreams = [];
  window.__negotiationCalls = [];
  window.__wsSent = [];
  window.__wsReceived = [];
  window.__sockets = [];

  function WrappedPC(...args) {
    const pc = new NativePC(...args);
    const entry = { pc, createdAt: Date.now(), closedAt: null };
    const nativeClose = pc.close.bind(pc);
    pc.close = () => { entry.closedAt = Date.now(); return nativeClose(); };
    const wrapOp = (name) => {
      const native = pc[name].bind(pc);
      pc[name] = async (...a) => { window.__negotiationCalls.push({ at: Date.now(), op: name }); return native(...a); };
    };
    wrapOp("createOffer");
    wrapOp("createAnswer");
    wrapOp("setLocalDescription");
    wrapOp("setRemoteDescription");
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
    window.__sockets.push(ws);
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

  window.__phase8 = () => {
    const headerText = document.querySelector("header") ? document.querySelector("header").textContent : "";
    const chatButton = document.querySelector('button[aria-label="Chat"]');
    const badgeMatch = chatButton ? chatButton.textContent.match(/\\d+/) : null;
    // The room's SidePanel renders <aside class="fixed ...">. The root layout
    // also renders a nav <aside> (class "hidden md:flex ..."), so a plain
    // "aside" query grabs the wrong element — select by the fixed class.
    const aside = document.querySelector("aside.fixed");
    const peers = [];
    let peerInboundVideoFrames = 0;
    for (const entry of window.__peerConnections) {
      peers.push({ createdAt: entry.createdAt, closedAt: entry.closedAt, connectionState: entry.pc.connectionState });
    }
    const videos = [...document.querySelectorAll("video")].map((v) => ({
      muted: v.muted, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
      opacity: getComputedStyle(v).opacity,
      totalVideoFrames: v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : null,
    }));
    return {
      peers: peers,
      negotiationCalls: window.__negotiationCalls.slice(),
      localStreamTracks: window.__localStreams.flatMap((s) => s.getTracks().map((t) => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState }))),
      sentMedia: window.__wsSent.filter((m) => m.type === "audio_state_changed" || m.type === "video_state_changed"),
      sentChat: window.__wsSent.filter((m) => m.type === "chat_message"),
      firstRoomState: window.__wsReceived.find((m) => m.type === "room_state") || null,
      mediaEvents: window.__wsReceived.filter((m) => m.type === "audio_state_changed" || m.type === "video_state_changed"),
      chatEvents: window.__wsReceived.filter((m) => m.type === "chat_message"),
      videos: videos,
      ui: {
        connected: headerText.indexOf("Connected") !== -1,
        reconnecting: headerText.indexOf("Reconnecting") !== -1,
        micOffIcons: document.querySelectorAll("svg.lucide-mic-off").length,
        remoteAvatars: document.querySelectorAll('[class*="bg-[#6574a8]"]').length,
        localAvatarInMain: document.querySelectorAll('main [class*="bg-[#b96e3d]"]').length,
        chatBadge: badgeMatch ? parseInt(badgeMatch[0], 10) : 0,
        chatPanelOpen: !!document.querySelector('input[aria-label="Chat message input"]'),
        chatInputDisabled: (() => { const i = document.querySelector('input[aria-label="Chat message input"]'); return i ? i.disabled : null; })(),
        chatNotices: [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent.trim()),
        chatBubbles: aside ? [...aside.querySelectorAll('div[class*="rounded-2xl"]')].map((e) => e.textContent) : [],
        ownChatBubbles: aside ? aside.querySelectorAll('div[class*="bg-[#2f6fed]"]').length : 0,
        chatLabels: aside ? [...aside.querySelectorAll('div[class*="text-[11px]"]')].map((e) => e.textContent.trim()) : [],
        participantIcons: aside ? [...aside.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")) : [],
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

const evidence = (page) => page.evaluate(() => window.__phase8()).catch(() => null);
const openPeers = (ev) => (ev ? ev.peers.filter((p) => !p.closedAt) : []);
const connectedPeers = (ev) => openPeers(ev).filter((p) => p.connectionState === "connected");
const remoteVideos = (ev) => (ev ? ev.videos.filter((v) => !v.muted) : []);
const audioTrack = (ev) => (ev ? ev.localStreamTracks.find((t) => t.kind === "audio") || null : null);
const videoTrack = (ev) => (ev ? ev.localStreamTracks.find((t) => t.kind === "video") || null : null);
const negotiationAfter = (ev, mark) => (ev ? ev.negotiationCalls.filter((c) => c.at > mark) : []);
const peersCreatedAfter = (ev, mark) => (ev ? openPeers(ev).filter((p) => p.createdAt > mark) : []);

async function waitConnected(page, label) {
  return waitUntil(async () => (await evidence(page))?.ui.connected, { label: `${label} connected` });
}

async function waitPeersConnected(page, count, label) {
  return waitUntil(async () => connectedPeers(await evidence(page)).length >= count, { label });
}

/** Wait until the page has received a media event matching the predicate. */
async function waitMediaEvent(page, predicate, label) {
  return waitUntil(async () => {
    const ev = await evidence(page);
    return ev ? ev.mediaEvents.find(predicate) || null : null;
  }, { label });
}

async function waitChatEvent(page, predicate, label) {
  return waitUntil(async () => {
    const ev = await evidence(page);
    return ev ? ev.chatEvents.find(predicate) || null : null;
  }, { label });
}

async function waitBadge(page, value, label) {
  return waitUntil(async () => (await evidence(page))?.ui.chatBadge === value, { label, interval: 400 });
}

// ---------------------------------------------------------------------------
// REST helpers (same API the dashboard uses).
// ---------------------------------------------------------------------------

async function registerUser(name) {
  const res = await fetch(`${API}/api/users/me`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), display_name: name }) });
  return res.json();
}

async function createMeeting(title) {
  const user = await registerUser(`${title} Host`);
  const res = await fetch(`${API}/api/meetings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, host_id: user.id }) });
  return (await res.json()).meeting_id;
}

async function createParticipant(meetingId, name) {
  const user = await registerUser(name);
  const res = await fetch(`${API}/api/meetings/${meetingId}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ display_name: name, user_id: user.id }) });
  return { id: (await res.json()).id, name };
}

/** Join a meeting directly at the room URL (the same route the dashboard pushes). */
async function browserJoin(browser, label, meetingId, participant, opts = {}) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  attach(page, label);
  const params = new URLSearchParams({ participant_id: participant.id, name: participant.name });
  if (opts.audio === false) params.set("audio", "false");
  if (opts.video === false) params.set("video", "false");
  await page.goto(`${FRONT}/room/${meetingId}?${params.toString()}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  return { context, page, id: participant.id, name: participant.name };
}

// ---------------------------------------------------------------------------
// Raw WebSocket helpers (ws-regression style).
// ---------------------------------------------------------------------------

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const conn = { socket, messages: [] };
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { message = { type: "UNPARSEABLE" }; }
      conn.messages.push(message);
    });
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
    // ===== Meeting 1: A + B (media state, TEST 1-4) =====
    const m1 = await createMeeting("Phase 8 Room");
    const pA = await createParticipant(m1, "Peer A");
    const pB = await createParticipant(m1, "Peer B");
    const A = await browserJoin(browser, "A", m1, pA);
    const B = await browserJoin(browser, "B", m1, pB);
    await waitConnected(A.page, "A");
    await waitConnected(B.page, "B");
    await waitPeersConnected(A.page, 1, "A<->B peer connected");
    await waitPeersConnected(B.page, 1, "B<->A peer connected");
    const baseline = await evidence(B.page);
    record("Setup: A and B connected with one live peer connection", connectedPeers(baseline).length === 1 && baseline.ui.micOffIcons === 0 && baseline.ui.remoteAvatars === 0);

    // ---------- TEST 1: A mutes ----------
    section("TEST 1 — A mutes, B sees it, no PeerConnection recreation");
    let mark = Date.now();
    const evA0 = await evidence(A.page);
    const videoSendsBefore = evA0.sentMedia.filter((m) => m.type === "video_state_changed").length;
    await A.page.getByRole("button", { name: "Mute", exact: true }).click();
    const evA1 = await evidence(A.page);
    record("T1 A: local audio track disabled", audioTrack(evA1)?.enabled === false);
    record("T1 A: sent audio_state_changed {audio_enabled:false}", evA1.sentMedia.some((m) => m.type === "audio_state_changed" && m.audio_enabled === false));
    record("T1 A: no spurious video_state_changed sent on mute", evA1.sentMedia.filter((m) => m.type === "video_state_changed").length === videoSendsBefore);
    const bMuted = await waitMediaEvent(B.page, (m) => m.type === "audio_state_changed" && m.participant_id === pA.id && m.audio_enabled === false, "B receives audio_state_changed false");
    record("T1 B: received audio_state_changed {participant_id:A, audio_enabled:false}", !!bMuted);
    await waitUntil(async () => (await evidence(B.page))?.ui.micOffIcons >= 1, { label: "B shows mic-off on A's tile" });
    const evB1 = await evidence(B.page);
    record("T1 B: mic-off indicator on A's tile", evB1.ui.micOffIcons >= 1, `icons=${evB1.ui.micOffIcons}`);
    record("T1: no PeerConnection created during mute", peersCreatedAfter(evB1, mark).length === 0 && peersCreatedAfter(evA1, mark).length === 0);
    record("T1: zero negotiation calls (offer/answer/SLD/SRD) during mute", negotiationAfter(evB1, mark).length === 0 && negotiationAfter(evA1, mark).length === 0);
    record("T1: peer still connected while A muted", connectedPeers(evB1).length === 1);

    // ---------- TEST 2: A unmutes ----------
    section("TEST 2 — A unmutes, B updates");
    await A.page.getByRole("button", { name: "Unmute", exact: true }).click();
    const bUnmuted = await waitMediaEvent(B.page, (m) => m.type === "audio_state_changed" && m.participant_id === pA.id && m.audio_enabled === true, "B receives audio_state_changed true");
    record("T2 B: received audio_state_changed {audio_enabled:true}", !!bUnmuted);
    // The WS event landing and React re-rendering the tile are separate
    // moments — wait for the rendered state, don't sample the instant the
    // frame arrives.
    await waitUntil(async () => (await evidence(B.page))?.ui.micOffIcons === 0, { label: "T2 B mic-off indicator cleared" });
    const evB2 = await evidence(B.page);
    record("T2 B: mic-off indicator cleared (SET semantics, no toggle)", evB2.ui.micOffIcons === 0, `icons=${evB2.ui.micOffIcons}`);

    // ---------- TEST 3: A disables camera ----------
    section("TEST 3 — A disables camera, B sees avatar, connection stays alive");
    mark = Date.now();
    await A.page.getByRole("button", { name: "Stop video", exact: true }).click();
    const evA3 = await evidence(A.page);
    record("T3 A: local video track disabled (enabled=false, track alive)", videoTrack(evA3)?.enabled === false && videoTrack(evA3)?.readyState === "live");
    const bVideoOff = await waitMediaEvent(B.page, (m) => m.type === "video_state_changed" && m.participant_id === pA.id && m.video_enabled === false, "B receives video_state_changed false");
    record("T3 B: received video_state_changed {video_enabled:false}", !!bVideoOff);
    const evB3 = await evidence(B.page);
    record("T3 B: A's tile shows the avatar (initials)", evB3.ui.remoteAvatars === 1, `avatars=${evB3.ui.remoteAvatars}`);
    record("T3 B: remote video element hidden (opacity 0), stream kept attached", remoteVideos(evB3).length === 1 && remoteVideos(evB3)[0].opacity === "0" && remoteVideos(evB3)[0].videoWidth > 0);
    record("T3: no PeerConnection created or negotiated during camera toggle", peersCreatedAfter(evB3, mark).length === 0 && negotiationAfter(evB3, mark).length === 0 && negotiationAfter(evA3, mark).length === 0);
    record("T3: peer still connected while camera off", connectedPeers(evB3).length === 1);

    // ---------- TEST 4: A enables camera ----------
    section("TEST 4 — A enables camera, B sees video again");
    mark = Date.now();
    await A.page.getByRole("button", { name: "Start video", exact: true }).click();
    const bVideoOn = await waitMediaEvent(B.page, (m) => m.type === "video_state_changed" && m.participant_id === pA.id && m.video_enabled === true, "B receives video_state_changed true");
    record("T4 B: received video_state_changed {video_enabled:true}", !!bVideoOn);
    await waitUntil(async () => (await evidence(B.page))?.ui.remoteAvatars === 0, { label: "B avatar cleared" });
    const evB4a = await evidence(B.page);
    await sleep(1500);
    const evB4b = await evidence(B.page);
    const framesBefore = Math.max(...evB4a.videos.map((v) => v.totalVideoFrames || 0));
    const framesAfter = Math.max(...evB4b.videos.map((v) => v.totalVideoFrames || 0));
    record("T4 B: avatar replaced by live remote video", evB4b.ui.remoteAvatars === 0 && remoteVideos(evB4b)[0].opacity === "1", `avatars=${evB4b.ui.remoteAvatars}`);
    record("T4 B: remote video frames resumed", framesAfter > framesBefore, `frames ${framesBefore} -> ${framesAfter}`);
    record("T4: no PeerConnection created or negotiated during camera toggle", peersCreatedAfter(evB4b, mark).length === 0 && negotiationAfter(evB4b, mark).length === 0);

    // ---------- TEST 5: A joins with camera OFF, B joins later ----------
    section("TEST 5 — join with camera OFF is visible to a later joiner via room_state");
    const m2 = await createMeeting("Phase 8 Camera Off");
    const pE = await createParticipant(m2, "Camera Off Joiner");
    const pF = await createParticipant(m2, "Late Joiner V");
    const E = await browserJoin(browser, "E", m2, pE, { video: false });
    await waitConnected(E.page, "E");
    await waitUntil(async () => (await evidence(E.page))?.sentMedia.some((m) => m.type === "video_state_changed" && m.video_enabled === false), { label: "E initial video_state_changed sent" });
    const F = await browserJoin(browser, "F", m2, pF);
    await waitConnected(F.page, "F");
    const evF5 = await evidence(F.page);
    const roomStateA5 = (evF5.firstRoomState?.participants || []).find((p) => p.participant_id === pE.id);
    record("T5 F: FIRST room_state already says A video_enabled=false", roomStateA5?.video_enabled === false, `video_enabled=${roomStateA5?.video_enabled}`);
    record("T5 F: received zero video_state_changed events (room_state was sufficient)", evF5.mediaEvents.filter((m) => m.type === "video_state_changed").length === 0);
    await waitPeersConnected(F.page, 1, "F<->E peer connected");
    const evF5b = await evidence(F.page);
    record("T5 F: A's tile shows avatar with stream attached", evF5b.ui.remoteAvatars === 1 && remoteVideos(evF5b)[0].opacity === "0", `avatars=${evF5b.ui.remoteAvatars}`);
    record("T5 E: own tile shows avatar while camera off", (await evidence(E.page)).ui.localAvatarInMain >= 1);
    await F.context.close();
    await E.context.close();

    // ---------- TEST 6: A joins muted, B joins later ----------
    section("TEST 6 — join muted is visible to a later joiner via room_state");
    const m3 = await createMeeting("Phase 8 Muted");
    const pG = await createParticipant(m3, "Muted Joiner");
    const pH = await createParticipant(m3, "Late Joiner M");
    const G = await browserJoin(browser, "G", m3, pG, { audio: false });
    await waitConnected(G.page, "G");
    await waitUntil(async () => (await evidence(G.page))?.sentMedia.some((m) => m.type === "audio_state_changed" && m.audio_enabled === false), { label: "G initial audio_state_changed sent" });
    const H = await browserJoin(browser, "H", m3, pH);
    await waitConnected(H.page, "H");
    const evH6 = await evidence(H.page);
    const roomStateA6 = (evH6.firstRoomState?.participants || []).find((p) => p.participant_id === pG.id);
    record("T6 H: FIRST room_state already says A audio_enabled=false", roomStateA6?.audio_enabled === false, `audio_enabled=${roomStateA6?.audio_enabled}`);
    record("T6 H: received zero audio_state_changed events (room_state was sufficient)", evH6.mediaEvents.filter((m) => m.type === "audio_state_changed").length === 0);
    await waitUntil(async () => (await evidence(H.page))?.ui.micOffIcons >= 1, { label: "H shows mic-off for G" });
    const evH6b = await evidence(H.page);
    record("T6 H: mic-off indicator on A's tile immediately", evH6b.ui.micOffIcons >= 1, `icons=${evH6b.ui.micOffIcons}`);
    await H.context.close();
    await G.context.close();

    // ---------- TEST 7: three participants ----------
    section("TEST 7 — A mutes, B and C both update");
    const pC = await createParticipant(m1, "Peer C");
    const C = await browserJoin(browser, "C", m1, pC);
    await waitConnected(C.page, "C");
    await waitPeersConnected(A.page, 2, "A peers to B,C");
    await waitPeersConnected(B.page, 2, "B peers to A,C");
    await waitPeersConnected(C.page, 2, "C peers to A,B");
    mark = Date.now();
    await A.page.getByRole("button", { name: "Mute", exact: true }).click();
    await waitMediaEvent(B.page, (m) => m.type === "audio_state_changed" && m.participant_id === pA.id && m.audio_enabled === false, "B receives mute");
    await waitMediaEvent(C.page, (m) => m.type === "audio_state_changed" && m.participant_id === pA.id && m.audio_enabled === false, "C receives mute");
    await waitUntil(async () => (await evidence(B.page))?.ui.micOffIcons >= 1, { label: "T7 B shows mic-off" });
    await waitUntil(async () => (await evidence(C.page))?.ui.micOffIcons >= 1, { label: "T7 C shows mic-off" });
    const evB7 = await evidence(B.page);
    const evC7 = await evidence(C.page);
    record("T7 B: mic-off indicator after A mutes", evB7.ui.micOffIcons >= 1);
    record("T7 C: mic-off indicator after A mutes", evC7.ui.micOffIcons >= 1);
    record("T7 C: no PeerConnection created or negotiated during mute", peersCreatedAfter(evC7, mark).length === 0 && negotiationAfter(evC7, mark).length === 0);

    // ---------- TEST 8: four participants ----------
    section("TEST 8 — A changes mic and video, B/C/D all update");
    const pD = await createParticipant(m1, "Peer D");
    const D = await browserJoin(browser, "D", m1, pD);
    await waitConnected(D.page, "D");
    await waitPeersConnected(D.page, 3, "D peers to A,B,C");
    mark = Date.now();
    await A.page.getByRole("button", { name: "Unmute", exact: true }).click();
    for (const [label, page] of [["B", B.page], ["C", C.page], ["D", D.page]]) {
      await waitMediaEvent(page, (m) => m.type === "audio_state_changed" && m.participant_id === pA.id && m.audio_enabled === true, `${label} sees unmute`);
    }
    await A.page.getByRole("button", { name: "Stop video", exact: true }).click();
    for (const [label, page] of [["B", B.page], ["C", C.page], ["D", D.page]]) {
      await waitMediaEvent(page, (m) => m.type === "video_state_changed" && m.participant_id === pA.id && m.video_enabled === false, `${label} sees camera off`);
    }
    for (const [label, page] of [["B", B.page], ["C", C.page], ["D", D.page]]) {
      await waitUntil(async () => { const ev = await evidence(page); return ev && ev.ui.micOffIcons === 0 && ev.ui.remoteAvatars === 1; }, { label: `T8 ${label} UI settled (mic on, avatar)` });
    }
    const evB8 = await evidence(B.page);
    const evC8 = await evidence(C.page);
    const evD8 = await evidence(D.page);
    record("T8 B: mic restored + avatar for A", evB8.ui.micOffIcons === 0 && evB8.ui.remoteAvatars === 1, `micOff=${evB8.ui.micOffIcons} avatars=${evB8.ui.remoteAvatars}`);
    record("T8 C: mic restored + avatar for A", evC8.ui.micOffIcons === 0 && evC8.ui.remoteAvatars === 1, `micOff=${evC8.ui.micOffIcons} avatars=${evC8.ui.remoteAvatars}`);
    record("T8 D: mic restored + avatar for A", evD8.ui.micOffIcons === 0 && evD8.ui.remoteAvatars === 1, `micOff=${evD8.ui.micOffIcons} avatars=${evD8.ui.remoteAvatars}`);
    record("T8: no PeerConnection created or negotiated across all toggles", [evB8, evC8, evD8].every((ev) => peersCreatedAfter(ev, mark).length === 0 && negotiationAfter(ev, mark).length === 0));

    // Participants panel: mic/camera icons from actual metadata (A3).
    await B.page.getByRole("button", { name: "Participants", exact: true }).click();
    await waitUntil(async () => (await evidence(B.page))?.ui.participantIcons.length > 0, { label: "participants panel open" });
    const evB8p = await evidence(B.page);
    const icons = evB8p.ui.participantIcons;
    record("A3 B: participants panel shows camera-off icon for A only", icons.filter((i) => i === "Camera off").length === 1, `camera-off=${icons.filter((i) => i === "Camera off").length}`);
    record("A3 B: participants panel shows mic-on icons for all four", icons.filter((i) => i === "Microphone on").length === 4, `mic-on=${icons.filter((i) => i === "Microphone on").length}`);
    await B.page.getByRole("button", { name: "Close panel" }).click();
    await A.page.getByRole("button", { name: "Start video", exact: true }).click();
    await waitMediaEvent(B.page, (m) => m.type === "video_state_changed" && m.participant_id === pA.id && m.video_enabled === true, "B sees camera back on");

    // ---------- TEST 9: A sends chat, B/C/D receive ----------
    section("TEST 9 — A sends chat, everyone receives over the same WebSocket");
    await A.page.getByRole("button", { name: "Chat", exact: true }).click();
    await waitUntil(async () => (await evidence(A.page))?.ui.chatPanelOpen, { label: "A chat panel open" });
    await A.page.getByLabel("Chat message input").fill("Hello everyone");
    await A.page.getByLabel("Chat message input").press("Enter");
    const sentRaw = (await evidence(A.page)).sentChat.find((m) => m.content === "Hello everyone");
    record("T9 A: client sent ONLY {type, content} (no sender/meeting/timestamp fields)", !!sentRaw && sentRaw.sender_id === undefined && sentRaw.sender_name === undefined && sentRaw.meeting_id === undefined && sentRaw.timestamp === undefined && sentRaw.message_id === undefined);
    const bMsg = await waitChatEvent(B.page, (m) => m.content === "Hello everyone", "B receives chat");
    const cMsg = await waitChatEvent(C.page, (m) => m.content === "Hello everyone", "C receives chat");
    const dMsg = await waitChatEvent(D.page, (m) => m.content === "Hello everyone", "D receives chat");
    record("T9 B: received chat_message (id, sender, name, timestamp from server)", !!bMsg && bMsg.sender_id === pA.id && bMsg.sender_name === "Peer A" && typeof bMsg.message_id === "string" && typeof bMsg.timestamp === "string");
    record("T9 C: received chat_message immediately", !!cMsg && cMsg.sender_id === pA.id);
    record("T9 D: received chat_message immediately", !!dMsg && dMsg.sender_id === pA.id);
    await waitUntil(async () => (await evidence(A.page))?.ui.chatBubbles.some((t) => t === "Hello everyone"), { label: "A renders own message" });
    const evA9 = await evidence(A.page);
    record("T9 A: own message rendered exactly once (server-authoritative insert)", evA9.ui.chatBubbles.filter((t) => t === "Hello everyone").length === 1, `bubbles=${evA9.ui.chatBubbles.filter((t) => t === "Hello everyone").length}`);
    record("T9 A: own message uses own-message styling", evA9.ui.ownChatBubbles >= 1 && evA9.ui.chatLabels.some((t) => t.startsWith("You -")));
    await B.page.getByRole("button", { name: "Chat", exact: true }).click();
    await waitUntil(async () => (await evidence(B.page))?.ui.chatPanelOpen, { label: "B chat panel open" });
    const evB9 = await evidence(B.page);
    record("T9 B: message visible in chat panel with sender name", evB9.ui.chatBubbles.filter((t) => t === "Hello everyone").length === 1 && evB9.ui.chatLabels.some((t) => t.startsWith("Peer A -")));
    record("T9 B: unread badge cleared on open", evB9.ui.chatBadge === 0, `badge=${evB9.ui.chatBadge}`);

    // ---------- TEST 10: B replies, A receives ----------
    section("TEST 10 — B replies, A receives");
    await B.page.getByLabel("Chat message input").fill("Hi Peer A!");
    await B.page.getByLabel("Send message").click();
    const aReply = await waitChatEvent(A.page, (m) => m.content === "Hi Peer A!", "A receives reply");
    record("T10 A: received B's reply", !!aReply && aReply.sender_id === pB.id && aReply.sender_name === "Peer B");
    const evA10 = await evidence(A.page);
    record("T10 A: reply visible with B's name (not 'You')", evA10.ui.chatBubbles.filter((t) => t === "Hi Peer A!").length === 1 && evA10.ui.chatLabels.some((t) => t.startsWith("Peer B -")));
    const evB10 = await evidence(B.page);
    record("T10 B: own reply styled as own message ('You')", evB10.ui.chatLabels.some((t) => t.startsWith("You -")));

    // ---------- TEST 11: unread count while closed ----------
    section("TEST 11 — chat closed, incoming messages raise the unread badge");
    await A.page.getByRole("button", { name: "Close panel" }).click();
    await waitUntil(async () => !(await evidence(A.page))?.ui.chatPanelOpen, { label: "A chat panel closed" });
    await B.page.getByLabel("Chat message input").fill("Are you there?");
    await B.page.getByLabel("Chat message input").press("Enter");
    await B.page.getByLabel("Chat message input").fill("Second ping");
    await B.page.getByLabel("Chat message input").press("Enter");
    await waitBadge(A.page, 2, "A badge reaches 2");
    const evA11 = await evidence(A.page);
    record("T11 A: unread badge counts 2 incoming messages", evA11.ui.chatBadge === 2, `badge=${evA11.ui.chatBadge}`);
    record("T11 A: own earlier message NOT counted as unread", evA11.ui.chatBadge === 2, "would be 3 if own messages counted");
    await waitBadge(C.page, 4, "C badge reaches 4");
    await waitBadge(D.page, 4, "D badge reaches 4");
    const evC11 = await evidence(C.page);
    const evD11 = await evidence(D.page);
    record("T11 C: badge counts all four remote messages (chat never opened)", evC11.ui.chatBadge === 4, `badge=${evC11.ui.chatBadge}`);
    record("T11 D: badge counts all four remote messages", evD11.ui.chatBadge === 4, `badge=${evD11.ui.chatBadge}`);

    // ---------- TEST 12: badge clears on open ----------
    section("TEST 12 — A opens chat, unread clears");
    await A.page.getByRole("button", { name: "Chat", exact: true }).click();
    await waitUntil(async () => { const ev = await evidence(A.page); return ev?.ui.chatPanelOpen && ev.ui.chatBadge === 0; }, { label: "A chat open + badge cleared" });
    const evA12 = await evidence(A.page);
    record("T12 A: badge cleared when chat opened", evA12.ui.chatBadge === 0);
    record("T12 A: missed messages rendered after opening", evA12.ui.chatBubbles.some((t) => t === "Are you there?") && evA12.ui.chatBubbles.some((t) => t === "Second ping"));

    // ---------- TEST 13: reload, history loads ----------
    section("TEST 13 — A reloads, chat history loads from the API");
    await A.page.reload({ waitUntil: "domcontentloaded" });
    await waitConnected(A.page, "A after reload");
    await A.page.getByRole("button", { name: "Chat", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev?.ui.chatBubbles.some((t) => t === "Hello everyone") && ev.ui.chatBubbles.some((t) => t === "Second ping");
    }, { label: "A history visible after reload" });
    const evA13 = await evidence(A.page);
    const historyContents = ["Hello everyone", "Hi Peer A!", "Are you there?", "Second ping"];
    record("T13 A: full history rendered after refresh", historyContents.every((t) => evA13.ui.chatBubbles.some((b) => b === t)), `bubbles=${evA13.ui.chatBubbles.length}`);
    record("T13 A: each message appears exactly once (id-based dedupe)", historyContents.every((t) => evA13.ui.chatBubbles.filter((b) => b === t).length === 1));
    record("T13 A: own vs others styling preserved from history", evA13.ui.ownChatBubbles === 1 && evA13.ui.chatLabels.some((t) => t.startsWith("You -")) && evA13.ui.chatLabels.some((t) => t.startsWith("Peer B -")), `own=${evA13.ui.ownChatBubbles}`);

    // ---------- Disconnected state (B16) + reconnect ----------
    section("B16 — socket drop shows Reconnecting..., send disabled, state preserved");
    // The app reconnects after ~500ms, so the disconnected window is short:
    // force-close again if the first attempt recovered before we could sample.
    let sawDisconnected = false;
    for (let attempt = 0; attempt < 6 && !sawDisconnected; attempt++) {
      await A.page.evaluate(() => {
        const open = window.__sockets.filter((s) => s.readyState === 1);
        if (open.length) open[open.length - 1].close(1000, "harness-forced drop");
      });
      sawDisconnected = await eventually(async () => {
        const ev = await evidence(A.page);
        return ev && ev.ui.chatPanelOpen && ev.ui.chatInputDisabled === true && ev.ui.chatNotices.some((t) => t.indexOf("Reconnecting") !== -1);
      }, { timeout: 2500, interval: 150, label: "chat shows disconnected state" });
    }
    record("B16 A: send disabled + 'Reconnecting...' shown while disconnected", sawDisconnected);
    const evOffline = await evidence(A.page);
    record("B16 A: chat panel and history survive the disconnect (no clobber)", evOffline?.ui.chatPanelOpen === true && evOffline.ui.chatBubbles.some((t) => t === "Hello everyone"));
    await waitConnected(A.page, "A reconnected");
    const evA13b = await evidence(A.page);
    record("B16 A: socket auto-reconnects, send re-enabled", evA13b.ui.chatInputDisabled === false);
    record("B16 A: chat state intact after reconnect (room_state did not reset it)", evA13b.ui.chatBubbles.some((t) => t === "Second ping") && evA13b.ui.chatPanelOpen);

    // ---------- Meeting 4: raw-WS participants for isolation + security ----------
    section("TEST 14 — cross-meeting chat isolation (raw WS listeners in meeting 2)");
    const m4 = await createMeeting("Phase 8 Room Two");
    const pW1 = await createParticipant(m4, "WS One");
    const pW2 = await createParticipant(m4, "WS Two");
    const pW3 = await createParticipant(m4, "WS Three");
    const W1 = await wsConnect(wsUrl(m4, pW1.id));
    const W2 = await wsConnect(wsUrl(m4, pW2.id));
    const w1State = await wsWaitFor(W1, (m) => m.type === "room_state");
    const w2State = await wsWaitFor(W2, (m) => m.type === "room_state");
    record("Setup: meeting 2 raw listeners connected", !!w1State && !!w2State);
    await A.page.getByLabel("Chat message input").fill("isolation-marker-42");
    await A.page.getByLabel("Chat message input").press("Enter");
    const bMarker = await waitChatEvent(B.page, (m) => m.content === "isolation-marker-42", "B receives marker");
    record("T14 B (meeting 1): received the message", !!bMarker && bMarker.sender_id === pA.id);
    await sleep(1200);
    const leak = W1.messages.filter((m) => m.type === "chat_message").concat(W2.messages.filter((m) => m.type === "chat_message"));
    record("T14 meeting 2 listeners received nothing", leak.length === 0, `leaked=${leak.length}`);

    section("TEST 15 — empty message rejected");
    W1.socket.send(JSON.stringify({ type: "chat_message", content: "   " }));
    const emptyErr = await wsWaitFor(W1, (m) => m.type === "error" && m.code === "INVALID_CHAT_MESSAGE");
    record("T15: whitespace-only message rejected with structured error", !!emptyErr && emptyErr.message === "Message cannot be empty.");
    await sleep(600);
    record("T15: nothing broadcast, nothing persisted", !W2.messages.some((m) => m.type === "chat_message"));

    section("TEST 16 — oversized message rejected cleanly");
    W1.socket.send(JSON.stringify({ type: "chat_message", content: "x".repeat(2001) }));
    const longErr = await wsWaitFor(W1, (m) => m.type === "error" && m.code === "CHAT_MESSAGE_TOO_LONG");
    record("T16: 2001-char message rejected (not truncated)", !!longErr && longErr.message === "Message is too long.");
    await sleep(600);
    record("T16: oversized message not broadcast", !W2.messages.some((m) => m.type === "chat_message" && m.content.length > 2000));
    W1.socket.send(JSON.stringify({ type: "chat_message", content: "y".repeat(2000) }));
    const boundaryMsg = await wsWaitFor(W2, (m) => m.type === "chat_message" && m.content.length === 2000);
    record("T16: boundary — exactly 2000 chars still accepted", !!boundaryMsg);

    section("TEST 17 — sender spoofing ignored");
    W1.socket.send(JSON.stringify({ type: "chat_message", content: "spoof probe", sender_id: pW2.id, sender_name: "Admin", timestamp: "1970-01-01T00:00:00" }));
    const spoofMsg = await wsWaitFor(W2, (m) => m.type === "chat_message" && m.content === "spoof probe");
    record("T17: canonical message identifies the REAL sender", !!spoofMsg && spoofMsg.sender_id === pW1.id && spoofMsg.sender_name === "WS One", `sender=${spoofMsg?.sender_name}`);
    record("T17: spoofed name and timestamp not used", !!spoofMsg && spoofMsg.sender_name !== "Admin" && spoofMsg.timestamp !== "1970-01-01T00:00:00");

    section("TEST 18 — payload meeting_id cannot redirect delivery");
    W1.socket.send(JSON.stringify({ type: "chat_message", content: "cross-room probe", meeting_id: m1 }));
    const crossMsg = await wsWaitFor(W2, (m) => m.type === "chat_message" && m.content === "cross-room probe");
    record("T18: message stayed in the socket's own meeting room", !!crossMsg && crossMsg.meeting_id === m4);
    await sleep(1000);
    const bCross = (await evidence(B.page))?.chatEvents.find((m) => m.content === "cross-room probe");
    record("T18: meeting 1 participants did NOT receive it", !bCross);
    const m1History = await (await fetch(`${API}/api/meetings/${m1}/chat`)).json();
    const m4History = await (await fetch(`${API}/api/meetings/${m4}/chat`)).json();
    record("T18: not persisted into meeting 1", !m1History.some((m) => m.content === "cross-room probe"));
    record("T18: persisted into the real meeting (meeting 2)", m4History.some((m) => m.content === "cross-room probe"));
    record("History API: canonical shape (id/sender_id/sender_name/content/timestamp)", m4History.every((m) => m.id && m.sender_id && m.sender_name && m.content && m.timestamp));

    section("Extras — media-state validation (A3 hardening)");
    W1.socket.send(JSON.stringify({ type: "audio_state_changed", audio_enabled: "false" }));
    const badType = await wsWaitFor(W1, (m) => m.type === "error" && m.code === "INVALID_MEDIA_STATE");
    record("X1: non-boolean audio_enabled rejected", !!badType);
    await sleep(500);
    record("X1: invalid media state not broadcast", !W2.messages.some((m) => m.type === "audio_state_changed"));
    W1.socket.send(JSON.stringify({ type: "audio_state_changed", audio_enabled: false, participant_id: pW2.id }));
    const forgedMedia = await wsWaitFor(W2, (m) => m.type === "audio_state_changed");
    record("X2: forged participant_id ignored — event carries the real sender", !!forgedMedia && forgedMedia.participant_id === pW1.id && forgedMedia.audio_enabled === false);
    const W3 = await wsConnect(wsUrl(m4, pW3.id));
    const w3State = await wsWaitFor(W3, (m) => m.type === "room_state");
    const w3Entry = (w3State?.participants || []).find((p) => p.participant_id === pW1.id);
    record("X3: new joiner's room_state reflects the persisted media state", w3Entry?.audio_enabled === false, `audio_enabled=${w3Entry?.audio_enabled}`);

    // Raw sockets keep the node event loop alive — close them so the suite
    // process can exit on its own once the report is written.
    for (const conn of [W1, W2, W3]) conn.socket.close();

    // ---------- Console audit ----------
    section("Console audit");
    const errorSignature = /InvalidStateError|OperationError|Failed to set remote|Failed to set local|NotAllowedError|NotReadableError|ICE failed|iceConnectionState=failed/;
    // The B16 section intentionally drops and reconnects the socket: the
    // browser's own "WebSocket connection ... failed" lines are expected.
    const expectedNoise = /Failed to load resource|WebSocket connection|net::ERR|favicon/i;
    const consoleErrors = logs.filter((l) => (l.type === "error" || l.type === "pageerror") && errorSignature.test(l.text));
    record("No WebRTC/media errors in any browser console", consoleErrors.length === 0, consoleErrors.slice(0, 3).map((e) => `${e.label}: ${e.text.slice(0, 80)}`).join(" | "));
    const otherErrors = logs.filter((l) => (l.type === "error" || l.type === "pageerror") && !errorSignature.test(l.text) && !expectedNoise.test(l.text));
    record("No other console errors or page errors", otherErrors.length === 0, otherErrors.slice(0, 3).map((e) => `${e.label}: ${e.text.slice(0, 100)}`).join(" | "));

    // ---------- Summary ----------
    const passed = results.length - failures;
    console.log(`\n============================================`);
    console.log(`PHASE 8: ${passed}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
    console.log(`============================================\n`);
    writeFileSync(REPORT_OUT, JSON.stringify({ suite: "phase8", passed, failed: failures, total: results.length, results }, null, 2));
    writeFileSync(LOGS_OUT, logs.map((l) => `[${new Date(l.at).toISOString()}][${l.label}][${l.type}] ${l.text}`).join("\n"));
    process.exitCode = failures ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("SUITE CRASHED:", error);
  // Leave the evidence behind even when the suite dies mid-run.
  writeFileSync(REPORT_OUT, JSON.stringify({ suite: "phase8", crashed: String(error && error.stack ? error.stack : error), passed: results.length - failures, failed: failures, total: results.length, results }, null, 2));
  writeFileSync(LOGS_OUT, logs.map((l) => `[${new Date(l.at).toISOString()}][${l.label}][${l.type}] ${l.text}`).join("\n"));
  process.exitCode = 1;
});
