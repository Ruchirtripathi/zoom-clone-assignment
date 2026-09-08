/**
 * Phase 9 runtime verification harness (NOT part of the application).
 *
 * Drives real Edge (Chromium) sessions through the actual UI plus raw
 * WebSocket clients against the REAL running stack, and verifies:
 *
 *   Host controls (TEST 1-7, 16-18)
 *     - participant mute_all / remove_participant / meeting_ended all
 *       rejected with FORBIDDEN and never broadcast (server-authoritative)
 *     - host mute_all mutes every guest browser's OWN audio track (host
 *       stays unmuted), each guest publishes exactly one
 *       audio_state_changed, no guest ever sends mute_all (no event loop)
 *     - host removes a participant: target sees the exit overlay, stops all
 *       media and peer connections; others drop them from the room
 *     - unknown target / cross-meeting target / self-removal all rejected
 *     - a tampered participant frontend sending meeting_ended is still
 *       rejected by the backend
 *     - participant Leave vs host End-for-everyone distinction preserved
 *
 *   Reactions (TEST 8-11)
 *     - A sends a reaction: everyone sees a temporary floating pill that
 *       fades and unmounts (no accumulation)
 *     - multiple reactions from multiple participants all delivered
 *     - rate limit: a burst is capped at 5 per second, excess dropped
 *     - arbitrary emoji rejected with INVALID_REACTION
 *     - client sends only {type, reaction} — identity is server-derived
 *
 *   More menu (TEST 12-15)
 *     - Meeting info panel shows title / ID / host / scheduled time /
 *       invite link, with clipboard copies + toasts
 *     - real Fullscreen API enter/exit with truthful label
 *     - keyboard shortcuts fire outside inputs and never inside them
 *     - Escape and outside click close menus and panels
 *     - host tools visible only to the host; responsive at mobile width
 *
 * Also audits browser consoles for errors and records a JSON report.
 */
import { chromium } from "playwright";
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const FRONT = "http://localhost:3000";
const API = "http://127.0.0.1:8000";
const WS_BASE = "ws://127.0.0.1:8000";
const REPORT_OUT = new URL("./phase9-report.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const LOGS_OUT = new URL("./phase9-console.log", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

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

  window.__phase9 = () => {
    const headerText = document.querySelector("header") ? document.querySelector("header").textContent : "";
    // The room's SidePanel renders <aside class="fixed ...">. The root layout
    // also renders a nav <aside>, so a plain "aside" query grabs the wrong
    // element — select by the fixed class.
    const aside = document.querySelector("aside.fixed");
    const h2s = [];
    document.querySelectorAll("h2").forEach((e) => h2s.push(e.textContent.trim()));
    const menuButtons = [];
    document.querySelectorAll("[data-floating-menu] button").forEach((b) => {
      menuButtons.push(b.getAttribute("aria-label") || b.textContent.trim());
    });
    const statusToasts = [];
    document.querySelectorAll('[role="status"]').forEach((e) => statusToasts.push(e.textContent.trim()));
    const infoRows = [];
    const infoValues = [];
    const rows = [];
    const removeButtons = [];
    if (aside) {
      aside.querySelectorAll("div.text-xs.text-slate-500").forEach((e) => infoRows.push(e.textContent.trim()));
      aside.querySelectorAll("span.truncate").forEach((e) => infoValues.push(e.textContent.trim()));
      aside.querySelectorAll("div.text-sm.truncate").forEach((e) => rows.push(e.textContent.trim()));
      aside.querySelectorAll('button[aria-label^="Remove"]').forEach((b) => removeButtons.push(b.getAttribute("aria-label")));
    }
    const reactionToasts = [];
    document.querySelectorAll("[data-reaction-toast]").forEach((e) => reactionToasts.push(e.textContent.trim()));
    return {
      url: location.href,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      fullscreen: !!document.fullscreenElement,
      peers: window.__peerConnections.map((e) => ({ createdAt: e.createdAt, closedAt: e.closedAt, connectionState: e.pc.connectionState })),
      localStreamTracks: window.__localStreams.flatMap((s) => s.getTracks().map((t) => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState }))),
      sent: window.__wsSent.slice(),
      received: {
        muteAll: window.__wsReceived.filter((m) => m.type === "mute_all"),
        reaction: window.__wsReceived.filter((m) => m.type === "reaction"),
        removed: window.__wsReceived.filter((m) => m.type === "participant_removed"),
        left: window.__wsReceived.filter((m) => m.type === "participant_left"),
        ended: window.__wsReceived.filter((m) => m.type === "meeting_ended"),
        errors: window.__wsReceived.filter((m) => m.type === "error"),
        audio: window.__wsReceived.filter((m) => m.type === "audio_state_changed"),
      },
      ui: {
        connected: headerText.indexOf("Connected") !== -1,
        muted: !!document.querySelector('button[aria-label="Unmute"]'),
        hostToolsButton: !!document.querySelector('button[aria-label="Host tools"]'),
        floatingMenu: !!document.querySelector("[data-floating-menu]"),
        menuButtons: menuButtons,
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => d.getAttribute("aria-label")),
        h2s: h2s,
        exitOverlay: h2s.find((t) => t.indexOf("removed from the meeting") !== -1 || t.indexOf("ended by the host") !== -1 || t.indexOf("You left the meeting") !== -1 || t === "Meeting ended.") || null,
        statusToasts: statusToasts,
        chatPanelOpen: !!document.querySelector('input[aria-label="Chat message input"]'),
        participantRows: rows,
        removeButtons: removeButtons,
        infoRows: infoRows,
        infoValues: infoValues,
        reactionToasts: reactionToasts,
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

const evidence = (page) => page.evaluate(() => window.__phase9()).catch(() => null);
const openPeers = (ev) => (ev ? ev.peers.filter((p) => !p.closedAt) : []);
const connectedPeers = (ev) => openPeers(ev).filter((p) => p.connectionState === "connected");
const closedPeers = (ev) => (ev ? ev.peers.filter((p) => p.closedAt) : []);
const audioTrack = (ev) => (ev ? ev.localStreamTracks.find((t) => t.kind === "audio") || null : null);
const sentOf = (ev, type) => (ev ? ev.sent.filter((m) => m.type === type) : []);
const sentAfter = (ev, type, mark) => (ev ? ev.sent.filter((m) => m.type === type && m.at > mark) : []);

async function waitConnected(page, label) {
  return waitUntil(async () => (await evidence(page))?.ui.connected, { label: `${label} connected` });
}

async function waitPeersConnected(page, count, label) {
  return waitUntil(async () => connectedPeers(await evidence(page)).length >= count, { label });
}

// ---------------------------------------------------------------------------
// REST helpers (same API the dashboard uses).
// ---------------------------------------------------------------------------

async function registerUser(name) {
  const res = await fetch(`${API}/api/users/me`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), display_name: name }) });
  return res.json();
}

/** Creates a meeting AND joins its host user, so the host browser connects with role=host. */
async function createHostMeeting(title, opts = {}) {
  const user = await registerUser(`${title} Host`);
  const body = { title, host_id: user.id };
  if (opts.scheduledAt) body.scheduled_at = opts.scheduledAt;
  const res = await fetch(`${API}/api/meetings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const meetingId = (await res.json()).meeting_id;
  const joinRes = await fetch(`${API}/api/meetings/${meetingId}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ display_name: `${title} Host`, user_id: user.id }) });
  const host = await joinRes.json();
  return { meetingId, host: { id: host.id, name: `${title} Host`, role: host.role } };
}

async function createParticipant(meetingId, name) {
  const user = await registerUser(name);
  const res = await fetch(`${API}/api/meetings/${meetingId}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ display_name: name, user_id: user.id }) });
  return { id: (await res.json()).id, name };
}

/** Join a meeting directly at the room URL (the same route the dashboard pushes). */
async function browserJoin(browser, label, meetingId, participant, opts = {}) {
  const context = await browser.newContext({
    permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"],
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
  });
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
    // ===== Meeting 1: host H + browsers A, B, C =====
    const m1 = await createHostMeeting("Phase 9 Room", { scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    const pA = await createParticipant(m1.meetingId, "Peer A");
    const pB = await createParticipant(m1.meetingId, "Peer B");
    const pC = await createParticipant(m1.meetingId, "Peer C");
    const H = await browserJoin(browser, "H", m1.meetingId, m1.host);
    const A = await browserJoin(browser, "A", m1.meetingId, pA);
    const B = await browserJoin(browser, "B", m1.meetingId, pB);
    const C = await browserJoin(browser, "C", m1.meetingId, pC);
    for (const [label, page] of [["H", H.page], ["A", A.page], ["B", B.page], ["C", C.page]]) {
      await waitConnected(page, label);
    }
    await waitPeersConnected(H.page, 3, "H peers to A,B,C");
    await waitPeersConnected(A.page, 3, "A peers to H,B,C");
    await waitPeersConnected(B.page, 3, "B peers to H,A,C");
    await waitPeersConnected(C.page, 3, "C peers to H,A,B");
    record("Setup: four browsers connected in a full mesh", true, `meeting=${m1.meetingId}`);

    section("Host tools visibility");
    const visH = await evidence(H.page);
    const visA = await evidence(A.page);
    const visB = await evidence(B.page);
    const visC = await evidence(C.page);
    record("Host sees the Host tools button", visH.ui.hostToolsButton === true);
    record("Participants do NOT see Host tools (hidden, not just disabled)", visA.ui.hostToolsButton === false && visB.ui.hostToolsButton === false && visC.ui.hostToolsButton === false);

    // ===== Meeting 2: raw-WS room for protocol-level security tests =====
    const m2 = await createHostMeeting("Phase 9 Protocol");
    const w1p = await createParticipant(m2.meetingId, "Raw One");
    const w2p = await createParticipant(m2.meetingId, "Raw Two");
    const WH = await wsConnect(wsUrl(m2.meetingId, m2.host.id));
    const W1 = await wsConnect(wsUrl(m2.meetingId, w1p.id));
    const W2 = await wsConnect(wsUrl(m2.meetingId, w2p.id));
    await wsWaitFor(WH, (m) => m.type === "room_state");
    await wsWaitFor(W1, (m) => m.type === "room_state");
    await wsWaitFor(W2, (m) => m.type === "room_state");

    section("TEST 1 — participant mute_all rejected, never broadcast");
    W1.socket.send(JSON.stringify({ type: "mute_all" }));
    const t1err = await wsWaitFor(W1, (m) => m.type === "error" && m.code === "FORBIDDEN");
    record("T1: participant receives FORBIDDEN with the exact spec message", !!t1err && t1err.message === "Only the host can perform this action.");
    await sleep(700);
    record("T1: no mute_all broadcast to anyone", !W2.messages.some((m) => m.type === "mute_all") && !WH.messages.some((m) => m.type === "mute_all"));
    record("T1: no audio_state_changed side effects", !W2.messages.some((m) => m.type === "audio_state_changed"));

    section("TEST 2 — participant remove_participant (targeting the host) rejected");
    W1.socket.send(JSON.stringify({ type: "remove_participant", target_participant_id: m2.host.id }));
    const t2err = await wsWaitFor(W1, (m) => m.type === "error" && m.code === "FORBIDDEN");
    record("T2: participant receives FORBIDDEN (cannot remove the host)", !!t2err);
    await sleep(700);
    record("T2: host still connected, no participant_removed broadcast", !W2.messages.some((m) => m.type === "participant_removed") && !WH.messages.some((m) => m.type === "participant_removed"));

    section("TEST 3 — participant meeting_ended rejected");
    W1.socket.send(JSON.stringify({ type: "meeting_ended" }));
    const t3err = await wsWaitFor(W1, (m) => m.type === "error" && m.code === "FORBIDDEN");
    record("T3: participant receives FORBIDDEN", !!t3err);
    await sleep(700);
    const m2After = await (await fetch(`${API}/api/meetings/${m2.meetingId}`)).json();
    record("T3: meeting still active, nobody received meeting_ended", m2After.status !== "ended" && !W2.messages.some((m) => m.type === "meeting_ended") && !WH.messages.some((m) => m.type === "meeting_ended"));

    section("TEST 6 — host removes a nonexistent participant");
    WH.socket.send(JSON.stringify({ type: "remove_participant", target_participant_id: "00000000-0000-0000-0000-000000000000" }));
    const t6err = await wsWaitFor(WH, (m) => m.type === "error" && m.code === "INVALID_TARGET");
    record("T6: unknown target rejected with a clear error", !!t6err && t6err.message === "That participant is not in this meeting.");

    section("TEST 7 — host cannot remove themselves");
    WH.socket.send(JSON.stringify({ type: "remove_participant", target_participant_id: m2.host.id }));
    const t7err = await wsWaitFor(WH, (m) => m.type === "error" && m.code === "CANNOT_REMOVE_SELF");
    record("T7: self-removal rejected with guidance to use End/Leave", !!t7err && t7err.message.includes("End the meeting"));

    section("TEST 11 — arbitrary emoji rejected");
    W1.socket.send(JSON.stringify({ type: "reaction", reaction: "🚀" }));
    const t11err = await wsWaitFor(W1, (m) => m.type === "error" && m.code === "INVALID_REACTION");
    record("T11: unsupported emoji rejected with INVALID_REACTION", !!t11err && t11err.message === "That reaction is not supported.");
    await sleep(700);
    record("T11: invalid reaction never broadcast", !W2.messages.some((m) => m.type === "reaction"));

    section("TEST 10 — reaction rate limit (5 per rolling second)");
    for (let i = 0; i < 10; i++) W1.socket.send(JSON.stringify({ type: "reaction", reaction: "👏" }));
    await sleep(1200);
    const burst = W2.messages.filter((m) => m.type === "reaction" && m.participant_id === w1p.id && m.reaction === "👏");
    record("T10: burst of 10 capped at exactly 5 broadcasts", burst.length === 5, `received=${burst.length}`);
    record("T10: the first five carried server-derived identity", burst.every((m) => m.participant_name === "Raw One" && !!m.timestamp));

    for (const conn of [WH, W1, W2]) conn.socket.close();

    // ===== Back in meeting 1: reactions through the real UI =====
    section("TEST 8 — A reacts, everyone sees a temporary floating reaction");
    let mark = Date.now();
    await A.page.getByRole("button", { name: "React", exact: true }).click();
    await waitUntil(async () => (await evidence(A.page))?.ui.floatingMenu, { label: "A reaction picker open" });
    const pickerButtons = (await evidence(A.page)).ui.menuButtons;
    record("T8: picker offers exactly the eight allowed reactions", pickerButtons.filter((n) => n.startsWith("Send ")).length === 8, `labels=${pickerButtons.filter((n) => n.startsWith("Send ")).length}`);
    await A.page.getByRole("button", { name: "Send 👍" }).click();
    const sentReaction = sentOf(await evidence(A.page), "reaction").find((m) => m.reaction === "👍");
    record("T8: client sent ONLY {type, reaction} — no identity fields", !!sentReaction && sentReaction.participant_id === undefined && sentReaction.participant_name === undefined && sentReaction.timestamp === undefined && sentReaction.meeting_id === undefined);
    for (const [label, page] of [["H", H.page], ["B", B.page], ["C", C.page]]) {
      await waitUntil(async () => (await evidence(page))?.ui.reactionToasts.some((t) => t.includes("👍") && t.includes("Peer A")), { label: `${label} sees A's 👍` });
    }
    record("T8: H, B and C all saw the temporary 👍 attributed to Peer A", true);
    const rxEvent = (await evidence(B.page)).received.reaction.find((m) => m.reaction === "👍");
    record("T8: broadcast carries participant_id/name/reaction/timestamp", !!rxEvent && rxEvent.participant_id === pA.id && rxEvent.participant_name === "Peer A" && rxEvent.reaction === "👍" && !!rxEvent.timestamp);
    // Temporary: the pill fades out and unmounts — nothing accumulates.
    await waitUntil(async () => (await evidence(B.page))?.ui.reactionToasts.length === 0, { timeout: 8000, label: "B reaction toast unmounted" });
    record("T8: reaction toast is temporary (unmounted after ~3s)", (await evidence(H.page)).ui.reactionToasts.length === 0 && (await evidence(C.page)).ui.reactionToasts.length === 0);

    section("TEST 9 — multiple reactions from multiple participants all delivered");
    await A.page.getByRole("button", { name: "React", exact: true }).click();
    await A.page.getByRole("button", { name: "Send ❤️" }).click();
    await B.page.getByRole("button", { name: "React", exact: true }).click();
    await B.page.getByRole("button", { name: "Send 🎉" }).click();
    for (const [label, page] of [["H", H.page], ["A", A.page], ["B", B.page], ["C", C.page]]) {
      await waitUntil(async () => {
        const ev = await evidence(page);
        return ev && ev.ui.reactionToasts.some((t) => t.includes("❤️")) && ev.ui.reactionToasts.some((t) => t.includes("🎉"));
      }, { label: `${label} sees both reactions` });
    }
    record("T9: every browser displayed both the ❤️ and the 🎉 simultaneously", true);
    await waitUntil(async () => (await evidence(C.page))?.ui.reactionToasts.length === 0, { timeout: 8000, label: "T9 toasts faded" });
    record("T9: multiple reactions do not accumulate (all unmounted)", (await evidence(H.page)).ui.reactionToasts.length === 0);

    section("TEST 4 — host mutes all, guests mute their own tracks, host stays unmuted");
    mark = Date.now();
    await H.page.getByRole("button", { name: "Host tools", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(H.page);
      return ev && ev.ui.floatingMenu && ev.ui.menuButtons.includes("Mute all");
    }, { label: "H host tools menu lists Mute all" });
    const hostMenuButtons = (await evidence(H.page)).ui.menuButtons;
    record("T4: host tools menu offers Mute all / Manage participants / End meeting", ["Mute all", "Manage participants", "End meeting"].every((n) => hostMenuButtons.includes(n)), hostMenuButtons.join(", "));
    await H.page.getByRole("button", { name: "Mute all", exact: true }).click();
    for (const [label, page] of [["A", A.page], ["B", B.page], ["C", C.page]]) {
      await waitUntil(async () => {
        const ev = await evidence(page);
        return ev && ev.received.muteAll.length === 1 && audioTrack(ev)?.enabled === false && ev.ui.muted === true;
      }, { label: `${label} muted its own track after mute_all` });
    }
    record("T4: every guest disabled its OWN local audio track + UI shows muted", true);
    // The guest waitUntils above resolve the moment each guest disables its
    // own track — the audio_state_changed round trip to the host is still in
    // flight, so wait for the host to have all three before asserting.
    await waitUntil(async () => {
      const ev = await evidence(H.page);
      return ev && ev.received.audio.filter((m) => m.at > mark && m.audio_enabled === false).length === 3;
    }, { label: "H received all three guests' audio_state_changed" });
    const evA4 = await evidence(A.page);
    const evB4 = await evidence(B.page);
    const evC4 = await evidence(C.page);
    const evH4 = await evidence(H.page);
    record("T4: each guest published exactly one audio_state_changed (no event loop)",
      sentAfter(evA4, "audio_state_changed", mark).length === 1 && sentAfter(evA4, "audio_state_changed", mark)[0].audio_enabled === false &&
      sentAfter(evB4, "audio_state_changed", mark).length === 1 && sentAfter(evB4, "audio_state_changed", mark)[0].audio_enabled === false &&
      sentAfter(evC4, "audio_state_changed", mark).length === 1 && sentAfter(evC4, "audio_state_changed", mark)[0].audio_enabled === false);
    record("T4: no guest ever sent mute_all back (event loop prevented)",
      sentOf(evA4, "mute_all").length === 0 && sentOf(evB4, "mute_all").length === 0 && sentOf(evC4, "mute_all").length === 0);
    record("T4: host is NOT muted by their own command", audioTrack(evH4)?.enabled === true && evH4.ui.muted === false);
    record("T4: host received no mute_all (excluded from own broadcast)", evH4.received.muteAll.length === 0);
    record("T4: host saw every guest's audio_state_changed", evH4.received.audio.filter((m) => m.at > mark && m.audio_enabled === false).length === 3, `events=${evH4.received.audio.filter((m) => m.at > mark && m.audio_enabled === false).length}`);
    record("T4: mute-all caused no renegotiation anywhere", [evA4, evB4, evC4, evH4].every((ev) => ev.peers.filter((p) => p.createdAt > mark).length === 0 && openPeers(ev).length === 3));

    section("TEST 5 — host removes B; B is disconnected, others see B leave");
    // A watches the participants panel while the host removes B from theirs.
    await A.page.getByRole("button", { name: "Participants", exact: true }).click();
    await waitUntil(async () => (await evidence(A.page))?.ui.participantRows.some((r) => r.includes("Peer B")), { label: "A panel lists Peer B" });
    await H.page.getByRole("button", { name: "Participants", exact: true }).click();
    await waitUntil(async () => (await evidence(H.page))?.ui.removeButtons.length === 3, { label: "H sees Remove buttons for the three guests" });
    const hostRemoveLabels = (await evidence(H.page)).ui.removeButtons;
    record("T5: host sees a Remove action per participant (not for self)", hostRemoveLabels.length === 3 && !hostRemoveLabels.some((l) => l.includes("Phase 9 Room Host")), hostRemoveLabels.join(" | "));
    // Participants never get Remove actions.
    const aRemoveLabels = (await evidence(A.page)).ui.removeButtons;
    record("T5: participants have no Remove actions", aRemoveLabels.length === 0, `A sees ${aRemoveLabels.length}`);
    mark = Date.now();
    await H.page.getByRole("button", { name: `Remove Peer B from meeting` }).click();
    await waitUntil(async () => (await evidence(B.page))?.ui.exitOverlay === "You were removed from the meeting.", { label: "B sees the removal overlay" });
    record("T5: B shown 'You were removed from the meeting.'", true);
    const evB5 = await evidence(B.page);
    record("T5: B's peer connections all closed", closedPeers(evB5).length === 3 && openPeers(evB5).length === 0, `closed=${closedPeers(evB5).length}`);
    record("T5: B's local tracks stopped (camera + mic)", evB5.localStreamTracks.length > 0 && evB5.localStreamTracks.every((t) => t.readyState === "ended"));
    // Phase 10: leaving/kick now lands on an exit screen with an explicit
    // reason; "Back to Home" performs the navigation.
    await B.page.getByRole("button", { name: "Back to Home" }).click();
    await waitUntil(async () => (await evidence(B.page))?.url === `${FRONT}/`, { timeout: 15000, label: "B navigated home" });
    record("T5: B navigated away from the room", true);
    const evA5 = await evidence(A.page);
    const evH5 = await evidence(H.page);
    const evC5 = await evidence(C.page);
    record("T5: others received participant_removed for B", evA5.received.removed.some((m) => m.participant_id === pB.id) && evC5.received.removed.some((m) => m.participant_id === pB.id));
    record("T5: A's participants panel no longer lists B", !evA5.ui.participantRows.some((r) => r.includes("Peer B")), evA5.ui.participantRows.join(", "));
    record("T5: A and H closed their peer to B, kept the others", closedPeers(evA5).length === 1 && connectedPeers(evA5).length === 2 && closedPeers(evH5).length === 1 && connectedPeers(evH5).length === 2, `A closed=${closedPeers(evA5).length} connected=${connectedPeers(evA5).length}`);
    record("T5: C (who never opened a panel) also dropped B", !evC5.ui.participantRows.includes("Peer B (you)") && connectedPeers(evC5).length === 2);
    await B.context.close();

    section("TEST 12 — Meeting info shows title, ID, host, scheduled time, invite link");
    await A.page.getByRole("button", { name: "More", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev && ev.ui.floatingMenu && ev.ui.menuButtons.includes("Meeting info");
    }, { label: "A More menu lists Meeting info" });
    await A.page.getByRole("button", { name: "Meeting info", exact: true }).click();
    // Wait for the REST details fetch to land — the panel renders local
    // fallbacks (4 rows) first and gains "Scheduled for" once meetingInfo
    // resolves, so 5 rows is the "fetch completed" signal.
    await waitUntil(async () => (await evidence(A.page))?.ui.infoRows.length === 5, { label: "A info panel open with all five rows" });
    const evA12 = await evidence(A.page);
    record("T12: panel shows the meeting title", evA12.ui.infoRows.includes("Meeting title") && evA12.ui.infoValues[0] === "Phase 9 Room", `title=${evA12.ui.infoValues[0]}`);
    record("T12: panel shows the correct Meeting ID", evA12.ui.infoRows.includes("Meeting ID") && evA12.ui.infoValues.includes(m1.meetingId));
    record("T12: panel shows the host", evA12.ui.infoRows.includes("Host") && evA12.ui.infoValues.includes("Phase 9 Room Host"));
    record("T12: scheduled time rendered when the meeting has one", evA12.ui.infoRows.includes("Scheduled for") && evA12.ui.infoValues.some((v) => v.length > 5));
    const expectedInvite = `${FRONT}/room/${m1.meetingId}`;
    record("T12: invite link is the bare room URL (no participant_id leaked)", evA12.ui.infoRows.includes("Invite link") && evA12.ui.infoValues.includes(expectedInvite), evA12.ui.infoValues[evA12.ui.infoRows.indexOf("Invite link")]);
    record("T12: no sensitive backend fields (only the five rows)", evA12.ui.infoRows.length === 5, `rows=${evA12.ui.infoRows.length}`);

    section("TEST 13 — Copy Invite Link / Copy Meeting ID use the clipboard + toast");
    // Scoped to the panel: the room header also has a "Copy invite link"
    // button and Playwright's accessible-name matching is case-insensitive.
    const panel = A.page.locator("aside.fixed");
    await panel.getByRole("button", { name: "Copy Invite link" }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev && ev.ui.statusToasts.includes("Meeting link copied");
    }, { label: "A sees 'Meeting link copied' toast" });
    const clipLink = await A.page.evaluate(() => navigator.clipboard.readText());
    record("T13: clipboard holds the invite link", clipLink === expectedInvite, clipLink);
    await panel.getByRole("button", { name: "Copy Meeting ID" }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev && ev.ui.statusToasts.includes("Meeting ID copied");
    }, { label: "A sees 'Meeting ID copied' toast" });
    const clipId = await A.page.evaluate(() => navigator.clipboard.readText());
    record("T13: clipboard holds the Meeting ID", clipId === m1.meetingId, clipId);

    section("TEST 14 — real Fullscreen API with truthful label");
    await A.page.getByRole("button", { name: "More", exact: true }).click();
    await waitUntil(async () => (await evidence(A.page))?.ui.menuButtons.includes("Enter fullscreen"), { label: "More menu offers Enter fullscreen" });
    await A.page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
    await waitUntil(async () => (await evidence(A.page))?.fullscreen, { label: "document entered fullscreen" });
    record("T14: requestFullscreen actually entered fullscreen", true);
    await A.page.getByRole("button", { name: "More", exact: true }).click();
    await waitUntil(async () => (await evidence(A.page))?.ui.menuButtons.includes("Exit fullscreen"), { label: "label switched to Exit fullscreen" });
    record("T14: menu label switched to 'Exit fullscreen' while active", true);
    await A.page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
    await waitUntil(async () => !(await evidence(A.page))?.fullscreen, { label: "document left fullscreen" });
    record("T14: exitFullscreen restored the window", true);

    section("TEST 15 — keyboard shortcuts work outside inputs, never inside");
    mark = Date.now();
    await A.page.keyboard.press("m");
    await waitUntil(async () => sentAfter(await evidence(A.page), "audio_state_changed", mark).length === 1, { label: "A sent unmute after pressing m" });
    let evA15 = await evidence(A.page);
    record("T15: 'm' toggles the microphone (A was muted by mute-all -> unmuted)", sentAfter(evA15, "audio_state_changed", mark)[0].audio_enabled === true && evA15.ui.muted === false);
    await A.page.keyboard.press("m");
    await waitUntil(async () => sentAfter(await evidence(A.page), "audio_state_changed", mark).length === 2, { label: "A re-muted via second m" });
    evA15 = await evidence(A.page);
    record("T15: second 'm' mutes again", sentAfter(evA15, "audio_state_changed", mark)[1].audio_enabled === false && evA15.ui.muted === true);
    await A.page.keyboard.press("c");
    await waitUntil(async () => (await evidence(A.page))?.ui.chatPanelOpen, { label: "'c' opened chat" });
    record("T15: 'c' toggles the chat panel open", true);
    const audioBeforeTyping = sentAfter(await evidence(A.page), "audio_state_changed", mark).length;
    await A.page.getByLabel("Chat message input").click();
    await A.page.keyboard.press("m");
    await A.page.keyboard.press("v");
    await sleep(600);
    evA15 = await evidence(A.page);
    record("T15: typing 'm'/'v' in the chat input does NOT toggle media", sentAfter(evA15, "audio_state_changed", mark).length === audioBeforeTyping && evA15.ui.muted === true, `audio sends while typing=${sentAfter(evA15, "audio_state_changed", mark).length - audioBeforeTyping}`);
    const typedValue = await A.page.getByLabel("Chat message input").inputValue();
    record("T15: the keystrokes landed in the input instead", typedValue.includes("m") && typedValue.includes("v"), `value='${typedValue}'`);
    await A.page.keyboard.press("Escape");
    await waitUntil(async () => !(await evidence(A.page))?.ui.chatPanelOpen, { label: "Escape closed chat" });
    record("T15: Escape closes an open panel", true);
    await A.page.keyboard.press("r");
    await waitUntil(async () => (await evidence(A.page))?.ui.floatingMenu, { label: "'r' opened the reaction picker" });
    await A.page.keyboard.press("Escape");
    await waitUntil(async () => !(await evidence(A.page))?.ui.floatingMenu, { label: "Escape closed the picker" });
    record("T15: 'r' opens the reaction picker; Escape closes it", true);
    await A.page.getByRole("button", { name: "More", exact: true }).click();
    await waitUntil(async () => (await evidence(A.page))?.ui.floatingMenu, { label: "More menu open" });
    await A.page.mouse.click(200, 15);
    await waitUntil(async () => !(await evidence(A.page))?.ui.floatingMenu, { label: "outside click closed the menu" });
    record("T15: clicking outside a floating menu closes it", true);

    section("TEST 16 — participant leaves; only the participant exits");
    mark = Date.now();
    // Participants leave immediately on End (Phase 2-8 behavior, preserved by
    // the spec) — only the host gets the End-for-everyone confirmation.
    await C.page.getByRole("button", { name: "End", exact: true }).click();
    // One click straight to the exit screen — no dialog step in between (the
    // confirmation exists only for the host's End-for-everyone, see TEST 17).
    await waitUntil(async () => (await evidence(C.page))?.ui.exitOverlay === "You left the meeting.", { timeout: 15000, label: "C sees the leave screen after a single click" });
    record("T16: participant's End button leaves immediately (no End-for-everyone dialog)", true);
    await C.page.getByRole("button", { name: "Back to Home" }).click();
    await waitUntil(async () => (await evidence(C.page))?.url === `${FRONT}/`, { timeout: 15000, label: "C navigated home" });
    record("T16: C left and returned to the dashboard", true);
    await waitUntil(async () => (await evidence(A.page))?.received.left.some((m) => m.participant_id === pC.id), { label: "A told that C left" });
    const evA16 = await evidence(A.page);
    const evH16 = await evidence(H.page);
    record("T16: A and H are still connected with their peer alive", evA16.ui.connected && evH16.ui.connected && connectedPeers(evA16).length === 1 && connectedPeers(evH16).length === 1);
    record("T16: A received participant_left (not participant_removed) for C", evA16.received.left.some((m) => m.participant_id === pC.id) && !evA16.received.removed.some((m) => m.participant_id === pC.id));
    const m1During = await (await fetch(`${API}/api/meetings/${m1.meetingId}`)).json();
    record("T16: the meeting itself stays active", m1During.status !== "ended");
    await C.context.close();

    section("TEST 18 — tampered participant frontend sending meeting_ended is rejected");
    mark = Date.now();
    await A.page.evaluate(() => {
      const open = window.__sockets.filter((s) => s.readyState === 1);
      if (open.length) open[open.length - 1].send(JSON.stringify({ type: "meeting_ended" }));
    });
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev && ev.ui.statusToasts.some((t) => t.includes("Only the host can perform this action."));
    }, { label: "A shown the FORBIDDEN notice" });
    record("T18: backend rejected the forged meeting_ended (notice shown)", true);
    await sleep(800);
    const evH18 = await evidence(H.page);
    const m1After18 = await (await fetch(`${API}/api/meetings/${m1.meetingId}`)).json();
    record("T18: nobody received meeting_ended and the meeting stays active", evH18.received.ended.length === 0 && m1After18.status !== "ended");
    record("T18: A is still connected and functional", (await evidence(A.page)).ui.connected);

    section("TEST 17 — host ends the meeting for everyone");
    mark = Date.now();
    // TEST 5 left H's participants panel open and it overlays the toolbar;
    // close it the way a user would (Escape closes every panel).
    await H.page.keyboard.press("Escape");
    await waitUntil(async () => (await evidence(H.page))?.ui.removeButtons.length === 0, { label: "H participants panel closed" });
    await H.page.getByRole("button", { name: "End", exact: true }).click();
    await waitUntil(async () => (await evidence(H.page))?.ui.dialogs.includes("End meeting for everyone?"), { label: "H sees the End-for-everyone confirmation" });
    record("T17: host's End button offers 'End meeting for everyone?'", true);
    await H.page.getByRole("button", { name: "Cancel", exact: true }).click();
    await waitUntil(async () => !(await evidence(H.page))?.ui.dialogs.includes("End meeting for everyone?"), { label: "Cancel dismissed the dialog" });
    record("T17: Cancel keeps the meeting running", (await evidence(A.page)).ui.connected);
    await H.page.getByRole("button", { name: "End", exact: true }).click();
    await H.page.getByRole("dialog", { name: "End meeting for everyone?" }).getByRole("button", { name: "End Meeting" }).click();
    await waitUntil(async () => sentAfter(await evidence(H.page), "meeting_ended", mark).length === 1, { label: "H sent meeting_ended once" });
    record("T17: host sent meeting_ended exactly once", true);
    // Phase 10: the ended screen is role-aware — a participant learns the
    // host ended it, the host gets the plain acknowledgement. Nobody is told
    // they were "removed".
    await waitUntil(async () => (await evidence(A.page))?.ui.exitOverlay === "This meeting has been ended by the host.", { label: "A sees the ended overlay" });
    await waitUntil(async () => (await evidence(H.page))?.ui.exitOverlay === "Meeting ended.", { label: "H sees the host ended overlay" });
    record("T17: everyone received meeting_ended; participants and host read the right words", true);
    const evA17 = await evidence(A.page);
    const evH17 = await evidence(H.page);
    record("T17: A stopped all media and closed all peer connections", evA17.localStreamTracks.length > 0 && evA17.localStreamTracks.every((t) => t.readyState === "ended") && openPeers(evA17).length === 0, `open peers=${openPeers(evA17).length}`);
    record("T17: host cleaned up its own connections too", openPeers(evH17).length === 0);
    for (const [label, page] of [["A", A.page], ["H", H.page]]) {
      await page.getByRole("button", { name: "Back to Home" }).click();
      await waitUntil(async () => (await evidence(page))?.url === `${FRONT}/`, { timeout: 15000, label: `${label} navigated home` });
    }
    record("T17: A and H navigated away after cleanup", true);
    const m1Final = await (await fetch(`${API}/api/meetings/${m1.meetingId}`)).json();
    record("T17: meeting marked ended in the database", m1Final.status === "ended" && !!m1Final.ended_at);

    section("Responsive — menus and panels at mobile width");
    const m3 = await createHostMeeting("Phase 9 Mobile");
    const M = await browserJoin(browser, "M", m3.meetingId, m3.host, { viewport: { width: 375, height: 812 } });
    await waitConnected(M.page, "M");
    await M.page.getByRole("button", { name: "React", exact: true }).click();
    await waitUntil(async () => (await evidence(M.page))?.ui.floatingMenu, { label: "M reaction picker open at 375px" });
    let evM = await evidence(M.page);
    record("R1: reaction picker fits a 375px viewport (no horizontal overflow)", evM.scrollWidth <= evM.innerWidth + 1, `scrollWidth=${evM.scrollWidth} innerWidth=${evM.innerWidth}`);
    await M.page.getByRole("button", { name: "Send 👍" }).click();
    await M.page.getByRole("button", { name: "More", exact: true }).click();
    await waitUntil(async () => (await evidence(M.page))?.ui.floatingMenu, { label: "M more menu open at 375px" });
    evM = await evidence(M.page);
    record("R2: More menu fits a 375px viewport", evM.scrollWidth <= evM.innerWidth + 1, `scrollWidth=${evM.scrollWidth}`);
    await M.page.keyboard.press("Escape");
    await waitUntil(async () => !(await evidence(M.page))?.ui.floatingMenu, { label: "Escape closed the menu" });
    record("R3: Escape closes menus on mobile too", true);
    await M.context.close();

    // ---------- Console audit ----------
    section("Console audit");
    const errorSignature = /InvalidStateError|OperationError|Failed to set remote|Failed to set local|NotAllowedError|NotReadableError|ICE failed|iceConnectionState=failed|fullscreen|Fullscreen/;
    const expectedNoise = /Failed to load resource|WebSocket connection|net::ERR|favicon/i;
    const consoleErrors = logs.filter((l) => (l.type === "error" || l.type === "pageerror") && errorSignature.test(l.text));
    record("No WebRTC/media/fullscreen errors in any browser console", consoleErrors.length === 0, consoleErrors.slice(0, 3).map((e) => `${e.label}: ${e.text.slice(0, 80)}`).join(" | "));
    const otherErrors = logs.filter((l) => (l.type === "error" || l.type === "pageerror") && !errorSignature.test(l.text) && !expectedNoise.test(l.text));
    record("No other console errors or page errors", otherErrors.length === 0, otherErrors.slice(0, 3).map((e) => `${e.label}: ${e.text.slice(0, 100)}`).join(" | "));

    // ---------- Summary ----------
    const passed = results.length - failures;
    console.log(`\n============================================`);
    console.log(`PHASE 9: ${passed}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
    console.log(`============================================\n`);
    writeFileSync(REPORT_OUT, JSON.stringify({ suite: "phase9", passed, failed: failures, total: results.length, results }, null, 2));
    writeFileSync(LOGS_OUT, logs.map((l) => `[${new Date(l.at).toISOString()}][${l.label}][${l.type}] ${l.text}`).join("\n"));
    process.exitCode = failures ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("SUITE CRASHED:", error);
  // Leave the evidence behind even when the suite dies mid-run.
  writeFileSync(REPORT_OUT, JSON.stringify({ suite: "phase9", crashed: String(error && error.stack ? error.stack : error), passed: results.length - failures, failed: failures, total: results.length, results }, null, 2));
  writeFileSync(LOGS_OUT, logs.map((l) => `[${new Date(l.at).toISOString()}][${l.label}][${l.type}] ${l.text}`).join("\n"));
  process.exitCode = 1;
});
