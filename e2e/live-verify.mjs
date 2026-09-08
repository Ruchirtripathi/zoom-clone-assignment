/**
 * LIVE production verification (Phase 12, STEPS 9-28) — runs against the
 * DEPLOYED services, not localhost:
 *
 *   Frontend : https://zoom-clone-frontend-beta.vercel.app   (Vercel, HTTPS)
 *   Backend  : https://zoom-clone-assignment-p30d.onrender.com (Render free)
 *   Signaling: wss://zoom-clone-assignment-p30d.onrender.com
 *
 * Covers: public /health, CORS from the frontend origin, raw wss join +
 * presence, the full browser meeting lifecycle (create -> direct invite
 * link -> lobby -> join), measured WebRTC media (getStats), chat, reactions,
 * host controls (mute all / remove / end), exit screens, DB persistence of
 * the ended status, dynamic-route refresh (no 404), real 404s, static
 * assets, mobile 375px responsive check, and a console error audit.
 *
 * NOTE on scope: both browsers run on this machine, so WebRTC media is
 * verified browser-to-browser over the local network with signaling over
 * the public wss endpoint — the same distinction the README makes.
 *
 * The local ISP flakily blocks *.vercel.app DNS, so Edge pins the domain
 * to a known-reachable Vercel anycast edge IP via --host-resolver-rules.
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const FRONT = "https://zoom-clone-frontend-beta.vercel.app";
const API = "https://zoom-clone-assignment-p30d.onrender.com";
const WS_BASE = "wss://zoom-clone-assignment-p30d.onrender.com";

const REPORT_OUT = new URL("./live-report.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const LOGS_OUT = new URL("./live-console.log", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

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

// Injected before any page script. Wraps and records RTCPeerConnection
// (with a getStats evidence collector), getUserMedia, and WebSocket (with
// URLs, sent frames and received messages). No backticks inside (this is
// itself a template literal).
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

  window.__live = () => {
    const texts = (selector) => Array.from(document.querySelectorAll(selector)).map((e) => e.textContent.trim());
    const headerText = document.querySelector("header") ? document.querySelector("header").textContent : "";
    const participantButton = document.querySelector('button[aria-label="Participants"]');
    const chatInput = document.querySelector('input[aria-label="Chat message input"]');

    const peers = window.__peerConnections.map((entry) => {
      return {
        createdAt: entry.createdAt,
        closedAt: entry.closedAt,
        connectionState: entry.pc.connectionState,
        iceConnectionState: entry.pc.iceConnectionState,
        signalingState: entry.pc.signalingState,
        hasRemoteDescription: !!entry.pc.remoteDescription,
      };
    });

    const videos = Array.from(document.querySelectorAll("video")).map((v) => ({
      muted: v.muted,
      hasSrcObject: !!v.srcObject,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      totalVideoFrames: v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : null,
    }));

    const meetingSockets = window.__sockets.filter((s) => s.url.indexOf("/api/ws/") !== -1);

    return {
      url: location.href,
      protocol: location.protocol,
      title: document.title,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      h1s: texts("h1"),
      h2s: texts("h2"),
      alerts: texts('[role="alert"]'),
      connected: headerText.indexOf("Connected") !== -1,
      lobby: !!document.querySelector("[data-meeting-lobby]"),
      lobbyNameInput: !!document.querySelector('input[aria-label="Your name"]'),
      bodyHasParticipantId: document.body.textContent.indexOf("participant_id") !== -1,
      exitReason: document.querySelector("[data-exit-screen]") ? document.querySelector("[data-exit-screen]").getAttribute("data-exit-screen") : null,
      notFound: !!document.querySelector("[data-meeting-not-found]"),
      participantCount: participantButton ? parseInt(participantButton.textContent.replace(/[^0-9]/g, ""), 10) || null : null,
      chatPanelOpen: !!chatInput,
      peers: peers,
      videos: videos,
      localStreamTracks: window.__localStreams.flatMap((s) => s.getTracks().map((t) => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState }))),
      wsUrls: meetingSockets.map((s) => s.url),
      sockets: meetingSockets.map((s) => s.ws.readyState),
      sent: window.__wsSent.slice(),
      chatEvents: window.__wsReceived.filter((m) => m.type === "chat_message"),
      reactionEvents: window.__wsReceived.filter((m) => m.type === "reaction"),
      errors: window.__wsReceived.filter((m) => m.type === "error"),
    };
  };

  // Full getStats snapshot — kept separate because it is async.
  window.__stats = async () => {
    const out = [];
    for (const entry of window.__peerConnections) {
      const pc = entry.pc;
      const stats = await pc.getStats();
      const inbound = []; const outbound = []; const candidates = {}; let selectedPair = null;
      stats.forEach((r) => {
        if (r.type === "inbound-rtp") inbound.push({ kind: r.kind, bytesReceived: r.bytesReceived, packetsReceived: r.packetsReceived, framesDecoded: r.framesDecoded ?? null });
        if (r.type === "outbound-rtp") outbound.push({ kind: r.kind, bytesSent: r.bytesSent, framesEncoded: r.framesEncoded ?? null });
        if (r.type === "local-candidate" || r.type === "remote-candidate") candidates[r.id] = { candidateType: r.candidateType, protocol: r.protocol, address: r.address ?? r.ip ?? null, port: r.port };
        if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded") && r.state !== "failed") selectedPair = r;
      });
      out.push({
        createdAt: entry.createdAt,
        closedAt: entry.closedAt,
        connectionState: pc.connectionState,
        inbound: inbound,
        outbound: outbound,
        selectedPair: selectedPair ? {
          state: selectedPair.state,
          local: candidates[selectedPair.localCandidateId] ?? null,
          remote: candidates[selectedPair.remoteCandidateId] ?? null,
        } : null,
      });
    }
    return out;
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

const evidence = (page) => page.evaluate(() => window.__live()).catch(() => null);
const statsOf = (page) => page.evaluate(() => window.__stats()).catch(() => []);
const openPeers = (ev) => (ev ? ev.peers.filter((p) => !p.closedAt) : []);
const connectedPeers = (ev) => openPeers(ev).filter((p) => p.connectionState === "connected");

// The local ISP intermittently drops routes to *.vercel.app anycast IPs —
// a navigation that times out usually succeeds on a retry (Chromium
// re-resolves and may land on a healthy edge).
async function gotoWithRetry(page, url, { attempts = 5, ...opts } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.goto(url, opts);
    } catch (error) {
      lastError = error;
      console.log(`   [nav retry ${i + 1}/${attempts}] ${String(error.message).slice(0, 90)}`);
      await sleep(2500);
    }
  }
  throw lastError;
}

async function newMeeting(browser, label, viewport) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"], viewport });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  attach(page, label);
  const response = await gotoWithRetry(page, FRONT, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByRole("button", { name: "New meeting" }).click();
    try {
      await page.waitForURL(/\/room\//, { timeout: 15000 });
      const meetingId = page.url().split("/room/")[1].split("?")[0];
      return { context, page, meetingId, homeStatus: response ? response.status() : null };
    } catch { /* click raced hydration — retry */ }
  }
  throw new Error(`${label}: could not start a new meeting`);
}

// Joining through the DIRECT invite link (bare /room/{id} URL, no
// participant_id) — the exact flow a recipient of an invite follows.
async function joinViaInviteLink(browser, label, meetingId, name, viewport) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"], viewport });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  attach(page, label);
  const response = await gotoWithRetry(page, `${FRONT}/room/${meetingId}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await waitUntil(async () => (await evidence(page))?.lobby, { label: `${label} lobby visible`, timeout: 90000 });
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join Meeting" }).click();
  await waitUntil(async () => (await evidence(page))?.connected, { label: `${label} connected`, timeout: 90000 });
  return { context, page, lobbyStatus: response ? response.status() : null };
}

// ---------------------------------------------------------------------------
// Raw WebSocket helpers (the `ws` package, straight to the Render service).
// ---------------------------------------------------------------------------
function wsConnect(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const conn = { socket, messages: [] };
    const timer = setTimeout(() => reject(new Error("wss connect timeout")), timeoutMs);
    socket.on("message", (raw) => {
      try { conn.messages.push(JSON.parse(raw.toString())); } catch { conn.messages.push({ type: "UNPARSEABLE" }); }
    });
    socket.on("open", () => { clearTimeout(timer); resolve(conn); });
    socket.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function wsWaitFor(conn, predicate, timeoutMs = 15000, label = "message") {
  const existing = conn.messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    const poll = setInterval(() => {
      const hit = conn.messages.find(predicate);
      if (hit) { clearTimeout(timer); clearInterval(poll); resolve(hit); }
    }, 150);
    setTimeout(() => clearInterval(poll), timeoutMs + 100);
  });
}

async function post(path, body) {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json();
}

async function main() {
  // =====================================================================
  section("S0 — Backend infrastructure (public URLs, no browser)");
  let res = await fetch(`${API}/health`);
  let body = await res.json().catch(() => ({}));
  record("GET /health returns 200 with status ok (wakes Render free tier)", res.status === 200 && body.status === "ok", `code=${res.status} status=${body.status} database=${body.database}`);

  res = await fetch(`${API}/api/health`);
  body = await res.json().catch(() => ({}));
  record("GET /api/health returns 200", res.status === 200 && body.status === "ok", `code=${res.status}`);

  res = await fetch(`${API}/api/meetings`);
  const meetingsList = await res.json().catch(() => null);
  record("GET /api/meetings returns 200 JSON array", res.status === 200 && Array.isArray(meetingsList), `code=${res.status}`);

  const pre = await fetch(`${API}/api/meetings`, {
    method: "OPTIONS",
    headers: { "Origin": FRONT, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });
  record("CORS preflight from the Vercel origin is allowed", pre.status === 200 && pre.headers.get("access-control-allow-origin") === FRONT, `code=${pre.status} allow=${pre.headers.get("access-control-allow-origin")}`);

  // =====================================================================
  section("S1 — Raw wss signaling against Render");
  const hostUser = await post("/api/users/me", { id: crypto.randomUUID(), display_name: "Live WS Host" });
  const wsMeeting = await post("/api/meetings", { title: "Live WS Probe", host_id: hostUser.id });
  const wsHost = await post(`/api/meetings/${wsMeeting.meeting_id}/join`, { display_name: "Live WS Host", user_id: hostUser.id });
  const H = await wsConnect(`${WS_BASE}/api/ws/meetings/${wsMeeting.meeting_id}?participant_id=${wsHost.id}`);
  const joinMsg = await wsWaitFor(H, (m) => m.type === "room_state", 15000, "host room_state");
  record("wss:// connect + join as host (room_state received)", joinMsg.type === "room_state", `url=${WS_BASE}/api/ws/...`);
  record("Join response carries role=host over wss", wsHost.role === "host" && joinMsg.type === "room_state", `role=${wsHost.role}`);

  const guestUser = await post("/api/users/me", { id: crypto.randomUUID(), display_name: "Live WS Guest" });
  const wsGuest = await post(`/api/meetings/${wsMeeting.meeting_id}/join`, { display_name: "Live WS Guest", user_id: guestUser.id });
  const G = await wsConnect(`${WS_BASE}/api/ws/meetings/${wsMeeting.meeting_id}?participant_id=${wsGuest.id}`);
  const presence = await wsWaitFor(H, (m) => m.type === "participant_joined", 15000, "participant_joined");
  record("Presence broadcast over wss (host sees participant_joined)", !!presence);
  H.socket.close();
  G.socket.close();

  // =====================================================================
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  try {
    // ===================================================================
    section("S2 — Meeting lifecycle through the deployed UI");
    const A = await newMeeting(browser, "A");
    console.log(`   meeting id: ${A.meetingId}`);
    record("Dashboard served over HTTPS (HTTP 200)", A.homeStatus === 200, `code=${A.homeStatus}`);
    record("Room URL is on the frontend domain (/room/{meeting_id})", A.page.url().startsWith(`${FRONT}/room/`), A.page.url());

    await waitUntil(async () => (await evidence(A.page))?.connected, { label: "A connected", timeout: 90000 });
    const evA0 = await evidence(A.page);
    record("A's WebSocket is wss:// to the Render backend", evA0.wsUrls.some((u) => u.startsWith(`${WS_BASE}/api/ws/meetings/`)), (evA0.wsUrls[0] || "none").slice(0, 80));
    record("A's local camera+mic tracks are live", evA0.localStreamTracks.filter((t) => t.readyState === "live").length >= 2, JSON.stringify(evA0.localStreamTracks));

    const B = await joinViaInviteLink(browser, "B", A.meetingId, "Browser B");
    record("Direct invite link (bare /room/{id}, no participant_id) reaches the lobby", B.lobbyStatus === 200 && !(await evidence(B.page)).bodyHasParticipantId, `code=${B.lobbyStatus}`);

    await waitUntil(async () => (await evidence(A.page))?.participantCount === 2, { label: "A sees 2 participants" });
    await waitUntil(async () => (await evidence(B.page))?.participantCount === 2, { label: "B sees 2 participants" });
    record("Both participants see participant count = 2", true);

    // ---------------------------------------------------------------
    section("S3 — Measured WebRTC media (P2P, signaling over public wss)");
    await waitUntil(async () => connectedPeers(await evidence(A.page)).length === 1, { label: "A peer connected", timeout: 60000 });
    await waitUntil(async () => connectedPeers(await evidence(B.page)).length === 1, { label: "B peer connected", timeout: 60000 });
    record("A: exactly 1 open peer connection, connected", openPeers(await evidence(A.page)).length === 1);
    record("B: exactly 1 open peer connection, connected", openPeers(await evidence(B.page)).length === 1);

    const statsA = await waitUntil(async () => {
      const s = await statsOf(A.page);
      const peer = s.find((p) => !p.closedAt && p.connectionState === "connected");
      if (!peer) return null;
      const v = peer.inbound.find((i) => i.kind === "video" && i.bytesReceived > 0 && (i.framesDecoded ?? 0) > 0);
      const a = peer.inbound.find((i) => i.kind === "audio" && i.bytesReceived > 0);
      return v && a ? peer : null;
    }, { label: "A receives B's media", timeout: 60000 });
    const statsB = await waitUntil(async () => {
      const s = await statsOf(B.page);
      const peer = s.find((p) => !p.closedAt && p.connectionState === "connected");
      if (!peer) return null;
      const v = peer.inbound.find((i) => i.kind === "video" && i.bytesReceived > 0 && (i.framesDecoded ?? 0) > 0);
      const a = peer.inbound.find((i) => i.kind === "audio" && i.bytesReceived > 0);
      return v && a ? peer : null;
    }, { label: "B receives A's media", timeout: 60000 });

    const vidA = statsA.inbound.find((i) => i.kind === "video");
    const vidB = statsB.inbound.find((i) => i.kind === "video");
    record("A receives B's VIDEO (inbound RTP bytes + decoded frames)", !!vidA && vidA.bytesReceived > 0 && (vidA.framesDecoded ?? 0) > 0, `bytes=${vidA?.bytesReceived} frames=${vidA?.framesDecoded}`);
    record("B receives A's VIDEO (inbound RTP bytes + decoded frames)", !!vidB && vidB.bytesReceived > 0 && (vidB.framesDecoded ?? 0) > 0, `bytes=${vidB?.bytesReceived} frames=${vidB?.framesDecoded}`);
    const audA = statsA.inbound.find((i) => i.kind === "audio");
    const audB = statsB.inbound.find((i) => i.kind === "audio");
    record("Bidirectional AUDIO (inbound RTP bytes both ways)", !!audA && !!audB && audA.bytesReceived > 0 && audB.bytesReceived > 0, `A=${audA?.bytesReceived}B=${audB?.bytesReceived}`);

    const pair = statsA.selectedPair;
    const direct = pair && pair.local && pair.remote && ["host", "srflx", "prflx"].includes(pair.local.candidateType) && pair.local.protocol === "udp";
    record("Selected candidate pair is direct UDP (media never routes via Render)", !!direct, pair ? `local=${pair.local.candidateType}/${pair.local.protocol} remote=${pair.remote.candidateType}` : "none");

    // ---------------------------------------------------------------
    section("S4 — In-meeting features over the deployed stack");
    await A.page.getByRole("button", { name: "Chat", exact: true }).click();
    await waitUntil(async () => (await evidence(A.page))?.chatPanelOpen, { label: "A chat panel open" });
    await A.page.getByLabel("Chat message input").fill("Hello from production");
    await A.page.getByLabel("Chat message input").press("Enter");
    await waitUntil(async () => (await evidence(B.page))?.chatEvents.some((m) => m.content === "Hello from production"), { label: "B receives chat" });
    record("Chat: A sends, B receives over wss", true);

    await B.page.getByRole("button", { name: "React", exact: true }).click();
    await B.page.getByRole("button", { name: "Send 👍" }).click();
    await waitUntil(async () => (await evidence(A.page))?.reactionEvents.some((m) => m.reaction === "👍"), { label: "A receives reaction" });
    record("Reactions: B sends 👍, A receives the broadcast", true);

    // Host controls: Mute all lives in the Host tools floating menu.
    await A.page.getByRole("button", { name: "Host tools", exact: true }).click();
    await waitUntil(async () => {
      const menuButton = A.page.getByRole("button", { name: "Mute all", exact: true });
      return await menuButton.isVisible().catch(() => false);
    }, { label: "Host tools menu lists Mute all" });
    await A.page.getByRole("button", { name: "Mute all", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(B.page);
      const audio = ev.localStreamTracks.filter((t) => t.kind === "audio");
      return audio.length > 0 && audio.every((t) => !t.enabled);
    }, { label: "B's own mic disabled after Mute all" });
    record("Host 'Mute all': B's client disables its OWN audio track", true);

    // ---------------------------------------------------------------
    section("S5 — Host teardown: remove participant, end meeting");
    // Remove lives in the Participants panel.
    await A.page.getByRole("button", { name: "Participants", exact: true }).click();
    await waitUntil(async () => {
      const btn = A.page.getByRole("button", { name: "Remove Browser B from meeting" });
      return await btn.isVisible().catch(() => false);
    }, { label: "host sees Remove for Browser B" });
    await A.page.getByRole("button", { name: "Remove Browser B from meeting" }).click();
    await waitUntil(async () => (await evidence(B.page))?.exitReason === "kicked", { label: "B sees the removed screen", timeout: 60000 });
    const evB = await evidence(B.page);
    record("Removed participant reads 'You were removed from the meeting.'", evB.h2s.includes("You were removed from the meeting."), evB.h2s.join(" | "));
    record("Removed participant's camera/mic stopped + peers closed", evB.localStreamTracks.length > 0 && evB.localStreamTracks.every((t) => t.readyState === "ended") && openPeers(evB).length === 0);

    // Close the side panel first — it is a fixed overlay that intercepts
    // pointer events over the toolbar.
    await A.page.getByRole("button", { name: "Close panel" }).click();
    await A.page.getByRole("button", { name: "End", exact: true }).click();
    await A.page.getByRole("dialog", { name: "End meeting for everyone?" }).getByRole("button", { name: "End Meeting" }).click();
    await waitUntil(async () => (await evidence(A.page))?.exitReason === "ended", { label: "A sees the ended screen", timeout: 60000 });
    const evA = await evidence(A.page);
    record("Host ends for everyone: host reads 'Meeting ended.'", evA.h2s.includes("Meeting ended."), evA.h2s.join(" | "));

    const endedStatus = await (await fetch(`${API}/api/meetings/${A.meetingId}`)).json();
    record("Ended status persisted in the SQLite database on Render", endedStatus.status === "ended", `status=${endedStatus.status}`);

    // Persistence over time: the meeting is still listed 20s later.
    await sleep(20000);
    const listAfter = await (await fetch(`${API}/api/meetings`)).json();
    record("Meeting still in GET /api/meetings 20s later (no data loss while up)", Array.isArray(listAfter) && listAfter.some((m) => m.meeting_id === A.meetingId));

    // ---------------------------------------------------------------
    section("S6 — Routing: dynamic refresh, 404s, static assets");

    const N = await newMeeting(browser, "A2"); // fresh host meeting for the reload + mobile tests
    const reloadCtx = await browser.newContext({ permissions: ["camera", "microphone"] });
    await reloadCtx.addInitScript(INIT_SCRIPT);
    const reloadPage = await reloadCtx.newPage();
    attach(reloadPage, "N");
    const first = await gotoWithRetry(reloadPage, `${FRONT}/room/${N.meetingId}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await waitUntil(async () => (await evidence(reloadPage))?.lobby, { label: "N lobby (first load)", timeout: 90000 });
    const second = await reloadPage.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
    await waitUntil(async () => (await evidence(reloadPage))?.lobby, { label: "N lobby (after refresh)", timeout: 90000 });
    record("Dynamic route refresh does NOT 404 (SSR /room/{id} both loads)", first.status() === 200 && second.status() === 200, `first=${first.status()} refresh=${second.status()}`);
    const active = await (await fetch(`${API}/api/meetings/${N.meetingId}/participants`)).json();
    // The host (N) is in the room; a lobby visitor must not add a second row.
    record("Refreshing the invite link creates no participant (host only)", Array.isArray(active) && active.filter((p) => !p.left_at).length === 1, `active=${Array.isArray(active) ? active.filter((p) => !p.left_at).length : "?"}`);
    await reloadCtx.close();

    const nfCtx = await browser.newContext();
    await nfCtx.addInitScript(INIT_SCRIPT);
    const nfPage = await nfCtx.newPage();
    attach(nfPage, "NF");
    const unknownRoute = await gotoWithRetry(nfPage, `${FRONT}/this-page-does-not-exist`, { waitUntil: "domcontentloaded", timeout: 90000 });
    record("Unknown route returns a real 404", unknownRoute.status() === 404, `code=${unknownRoute.status()}`);
    await gotoWithRetry(nfPage, `${FRONT}/room/0000000000`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await waitUntil(async () => (await evidence(nfPage))?.notFound, { label: "meeting not found screen", timeout: 30000 });
    record("Unknown meeting ID shows the 'Meeting not found' screen (no crash)", true);
    await nfCtx.close();

    // Static asset check, executed inside the already-connected room page so
    // it reuses the browser's healthy route to the Vercel edge.
    const chunkInfo = await N.page.evaluate(async () => {
      const res = await fetch("/", { credentials: "omit" });
      const html = await res.text();
      const chunk = html.match(/\/_next\/static\/[^"']+\.js/);
      if (!chunk) return { status: res.status, chunk: null, assetStatus: null };
      const asset = await fetch(chunk[0], { credentials: "omit" });
      return { status: res.status, chunk: chunk[0], assetStatus: asset.status };
    });
    record("Static asset served (/_next/static bundle, HTTP 200)", chunkInfo.assetStatus === 200, `${(chunkInfo.chunk || "?").slice(0, 60)} -> ${chunkInfo.assetStatus}`);

    // ---------------------------------------------------------------
    section("S7 — Mobile 375px responsive check");
    const M = await joinViaInviteLink(browser, "M", N.meetingId, "Mobile User", { width: 375, height: 667 });
    await waitUntil(async () => (await evidence(M.page))?.connected, { label: "M connected", timeout: 90000 });
    const evM = await evidence(M.page);
    record("Mobile 375px joins via invite link and renders the room", evM.connected === true && evM.innerWidth === 375);
    record("No horizontal scroll at 375px (dashboard-sized room UI)", evM.scrollWidth <= 375, `scrollWidth=${evM.scrollWidth}`);

    // ---------------------------------------------------------------
    section("S8 — Console error audit (production build)");
    // The "NF" context is excluded: those pages deliberately load 404s
    // (unknown route + unknown meeting), and the browser logs each
    // intentional 404 response as a console error.
    const errorLogs = logs.filter((l) => l.type === "pageerror" || l.type === "error").filter((l) => l.label !== "NF");
    const pageErrors = errorLogs.filter((l) => l.type === "pageerror");
    const consoleErrors = errorLogs.filter((l) => l.type === "error");
    record("No uncaught page errors in any browser", pageErrors.length === 0, pageErrors.slice(0, 3).map((e) => e.text.slice(0, 80)).join(" || "));
    record("No console.error output in any browser (excl. intentional 404 tests)", consoleErrors.length === 0, consoleErrors.slice(0, 3).map((e) => e.text.slice(0, 80)).join(" || "));

    await M.context.close();
    await N.context.close();
    await A.context.close();
    await B.context.close();
  } finally {
    await browser.close();
  }

  console.log(`\n========== SUMMARY: ${results.length - failures}/${results.length} checks passed ==========`);
  writeFileSync(REPORT_OUT, JSON.stringify({ front: FRONT, api: API, results, failures }, null, 2));
  writeFileSync(LOGS_OUT, JSON.stringify(logs, null, 2));
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("HARNESS FAILURE:", error);
  process.exit(2);
});
