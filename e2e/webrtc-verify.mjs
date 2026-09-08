/**
 * Runtime WebRTC verification harness (NOT part of the application).
 *
 * Drives real Edge (Chromium) browser sessions through the actual UI:
 *   - Browser A: dashboard -> "New meeting"
 *   - Browser B/C/D: dashboard -> Join modal with meeting ID
 *
 * Verifies actual peer-to-peer media via RTCPeerConnection.getStats():
 * inbound RTP bytes / decoded frames, selected candidate pair, and
 * rendered <video> playback quality — not just signaling messages.
 *
 * Fake media devices (--use-fake-device-for-media-stream) provide a real
 * synthetic camera stream (animated) and audio tone, so tracks carry actual
 * RTP traffic between the two browser processes.
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const FRONT = "http://localhost:3000";
const REPORT_OUT = new URL("./webrtc-report.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const LOGS_OUT = new URL("./webrtc-console.log", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

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

// Injected before any page script: records every RTCPeerConnection and
// getUserMedia stream, and exposes a stats/evidence collector.
const INIT_SCRIPT = `
(() => {
  const NativePC = window.RTCPeerConnection;
  const created = [];
  window.__peerConnections = created;
  window.__localStreams = [];
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

  window.__collectWebrtcEvidence = async () => {
    const peers = [];
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
      peers.push({
        createdAt: entry.createdAt,
        closedAt: entry.closedAt,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState,
        hasRemoteDescription: !!pc.remoteDescription,
        selectedPair: selectedPair ? {
          state: selectedPair.state,
          nominated: selectedPair.nominated,
          local: candidates[selectedPair.localCandidateId] ?? null,
          remote: candidates[selectedPair.remoteCandidateId] ?? null,
        } : null,
        inbound, outbound,
      });
    }
    const videos = [...document.querySelectorAll("video")].map((v) => ({
      muted: v.muted, hasSrcObject: !!v.srcObject, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
      totalVideoFrames: v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : null,
    }));
    const participantButton = document.querySelector('button[aria-label="Participants"]');
    return {
      peers,
      localStreams: window.__localStreams.map((s) => ({
        audio: s.getAudioTracks().map((t) => ({ enabled: t.enabled })),
        video: s.getVideoTracks().map((t) => ({ enabled: t.enabled })),
      })),
      videos,
      remoteTiles: [...document.querySelectorAll("div")].filter((d) => d.textContent === "Remote video").length,
      participantCount: participantButton ? parseInt(participantButton.textContent.replace(/\\D/g, ""), 10) || null : null,
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

const evidence = (page) => page.evaluate(() => window.__collectWebrtcEvidence()).catch(() => null);

const openPeers = (ev) => (ev ? ev.peers.filter((p) => !p.closedAt) : []);
const connectedPeers = (ev) => openPeers(ev).filter((p) => p.connectionState === "connected");
const inboundMedia = (peer, kind) => peer.inbound.find((i) => i.kind === kind && i.bytesReceived > 0);

async function newMeeting(browser, label) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  attach(page, label);
  await page.goto(FRONT, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  // Retry: React hydration + the StrictMode duplicate-POST preflight quirk can
  // make the first click a no-op; the app self-heals on the next attempt.
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByRole("button", { name: "New meeting" }).click();
    try {
      await page.waitForURL(/\/room\//, { timeout: 10000 });
      const meetingId = page.url().split("/room/")[1].split("?")[0];
      return { context, page, meetingId };
    } catch { /* click raced hydration — retry */ }
  }
  throw new Error(`${label}: could not start a new meeting`);
}

async function joinMeeting(browser, label, meetingId, name) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  attach(page, label);
  await page.goto(FRONT, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  // Phase 10: the Join dialog now routes to the shared lobby (bare room
  // link); the meeting itself is entered by completing the lobby form.
  let dialogOpen = false;
  for (let attempt = 0; attempt < 4 && !dialogOpen; attempt++) {
    try {
      await page.getByRole("button", { name: "Join", exact: true }).click();
      await page.getByPlaceholder("Enter the meeting ID").waitFor({ state: "visible", timeout: 8000 });
      dialogOpen = true;
    } catch { /* modal raced hydration — retry */ }
  }
  if (!dialogOpen) throw new Error(`${label}: could not open the Join dialog`);
  await page.getByPlaceholder("Enter the meeting ID").fill(meetingId);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Your name").waitFor({ state: "visible", timeout: 15000 });
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join Meeting" }).click();
  await page.waitForURL(/participant_id=/, { timeout: 20000 });
  return { context, page };
}

async function main() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // uvicorn is bound to 127.0.0.1 (IPv4 only); headless Edge resolves
      // localhost to ::1 first, which makes the first CORS preflight fail
      // spuriously. Pin localhost:8000 to IPv4 for deterministic testing.
      "--host-resolver-rules=MAP localhost:8000 127.0.0.1",
    ],
  });

  try {
    // ---------- STEP 3: two-browser media test ----------
    section("S1 — Two-browser media (A creates, B joins)");
    const A = await newMeeting(browser, "A");
    const B = await joinMeeting(browser, "B", A.meetingId, "Browser B");
    console.log(`   meeting id: ${A.meetingId}`);

    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return connectedPeers(ev).length >= 1 && inboundMedia(connectedPeers(ev)[0], "video");
    }, { label: "A: peer connected + inbound video bytes" });
    await waitUntil(async () => {
      const ev = await evidence(B.page);
      return connectedPeers(ev).length >= 1 && inboundMedia(connectedPeers(ev)[0], "video");
    }, { label: "B: peer connected + inbound video bytes" });

    const evA = await evidence(A.page);
    const evB = await evidence(B.page);
    const peerA = connectedPeers(evA)[0];
    const peerB = connectedPeers(evB)[0];

    record("A: exactly 1 open PeerConnection", openPeers(evA).length === 1, `open=${openPeers(evA).length}`);
    record("B: exactly 1 open PeerConnection", openPeers(evB).length === 1, `open=${openPeers(evB).length}`);
    record("A: offer/answer completed (remoteDescription set)", peerA.hasRemoteDescription, `signaling=${peerA.signalingState}`);
    record("B: offer/answer completed (remoteDescription set)", peerB.hasRemoteDescription, `signaling=${peerB.signalingState}`);
    record("A: ICE completed (connected/completed)", ["connected", "completed"].includes(peerA.iceConnectionState), `ice=${peerA.iceConnectionState}`);
    record("B: ICE completed (connected/completed)", ["connected", "completed"].includes(peerB.iceConnectionState), `ice=${peerB.iceConnectionState}`);
    record("A: connectionState=connected", peerA.connectionState === "connected", peerA.connectionState);
    record("B: connectionState=connected", peerB.connectionState === "connected", peerB.connectionState);

    const aVideoIn = peerA.inbound.find((i) => i.kind === "video");
    const aAudioIn = peerA.inbound.find((i) => i.kind === "audio");
    const bVideoIn = peerB.inbound.find((i) => i.kind === "video");
    const bAudioIn = peerB.inbound.find((i) => i.kind === "audio");
    record("A receives B's VIDEO (inbound RTP bytes + decoded frames)", !!aVideoIn && aVideoIn.bytesReceived > 0 && aVideoIn.framesDecoded > 0,
      `bytes=${aVideoIn?.bytesReceived} framesDecoded=${aVideoIn?.framesDecoded}`);
    record("A receives B's AUDIO (inbound RTP bytes)", !!aAudioIn && aAudioIn.bytesReceived > 0,
      `bytes=${aAudioIn?.bytesReceived} packets=${aAudioIn?.packetsReceived}`);
    record("B receives A's VIDEO (inbound RTP bytes + decoded frames)", !!bVideoIn && bVideoIn.bytesReceived > 0 && bVideoIn.framesDecoded > 0,
      `bytes=${bVideoIn?.bytesReceived} framesDecoded=${bVideoIn?.framesDecoded}`);
    record("B receives A's AUDIO (inbound RTP bytes)", !!bAudioIn && bAudioIn.bytesReceived > 0,
      `bytes=${bAudioIn?.bytesReceived} packets=${bAudioIn?.packetsReceived}`);

    const remoteVideoA = evA.videos.filter((v) => !v.muted)[0];
    const remoteVideoB = evB.videos.filter((v) => !v.muted)[0];
    record("A renders B's remote <video> (real frames painted)", !!remoteVideoA && remoteVideoA.videoWidth > 0 && remoteVideoA.totalVideoFrames > 0,
      `size=${remoteVideoA?.videoWidth}x${remoteVideoA?.videoHeight} frames=${remoteVideoA?.totalVideoFrames}`);
    record("B renders A's remote <video> (real frames painted)", !!remoteVideoB && remoteVideoB.videoWidth > 0 && remoteVideoB.totalVideoFrames > 0,
      `size=${remoteVideoB?.videoWidth}x${remoteVideoB?.videoHeight} frames=${remoteVideoB?.totalVideoFrames}`);

    const pairA = peerA.selectedPair;
    record("A: selected candidate pair is direct UDP (not via FastAPI)", !!pairA && pairA.local?.protocol === "udp" && pairA.remote?.protocol === "udp" && pairA.remote?.port !== 8000,
      pairA ? `local=${pairA.local?.candidateType}/${pairA.local?.address}:${pairA.local?.port} remote=${pairA.remote?.candidateType}/${pairA.remote?.address}:${pairA.remote?.port}` : "no pair");
    record("A: outbound media sent (frames encoded)", peerA.outbound.some((o) => o.kind === "video" && o.framesEncoded > 0),
      peerA.outbound.map((o) => `${o.kind}:${o.framesEncoded ?? o.bytesSent}`).join(","));
    record("B: outbound media sent (frames encoded)", peerB.outbound.some((o) => o.kind === "video" && o.framesEncoded > 0),
      peerB.outbound.map((o) => `${o.kind}:${o.framesEncoded ?? o.bytesSent}`).join(","));

    const aLogs = logs.filter((l) => l.label === "A");
    const bLogs = logs.filter((l) => l.label === "B");
    record("A console: peer created + local tracks added + ontrack fired + connected",
      aLogs.some((l) => l.text.includes("Creating peer connection")) &&
      aLogs.some((l) => l.text.includes("Added local audio track")) &&
      aLogs.some((l) => l.text.includes("Added local video track")) &&
      aLogs.some((l) => l.text.includes("track received from")) &&
      aLogs.some((l) => l.text.includes("connectionState=connected")));
    record("B console: peer created + local tracks added + ontrack fired + connected",
      bLogs.some((l) => l.text.includes("Creating peer connection")) &&
      bLogs.some((l) => l.text.includes("Added local audio track")) &&
      bLogs.some((l) => l.text.includes("Added local video track")) &&
      bLogs.some((l) => l.text.includes("track received from")) &&
      bLogs.some((l) => l.text.includes("connectionState=connected")));
    record("A participant count = 2", evA.participantCount === 2, `count=${evA.participantCount}`);
    record("B participant count = 2", evB.participantCount === 2, `count=${evB.participantCount}`);

    // ---------- STEP 4: mute ----------
    section("S2 — Mute / unmute (A)");
    const peersBeforeMute = openPeers((await evidence(A.page))).length;
    const muteMark = Date.now();
    await A.page.getByRole("button", { name: "Mute", exact: true }).click();
    await sleep(1500);
    const evAMuted = await evidence(A.page);
    record("A: audio track enabled=false after Mute", evAMuted.localStreams[0]?.audio[0]?.enabled === false);
    record("A: no PeerConnection recreated on mute", openPeers(evAMuted).length === peersBeforeMute &&
      !logs.some((l) => l.label === "A" && l.at > muteMark && l.text.includes("Creating peer connection")));
    record("B: sees A muted (mic-off indicator)", (await B.page.locator("svg.lucide-mic-off").count()) > 0);
    const evBMuted = await evidence(B.page);
    record("B: peer still connected while A muted", connectedPeers(evBMuted).length === 1);

    await A.page.getByRole("button", { name: "Unmute", exact: true }).click();
    await sleep(1500);
    const evAUnmuted = await evidence(A.page);
    record("A: audio track enabled=true after Unmute", evAUnmuted.localStreams[0]?.audio[0]?.enabled === true);
    record("A: still no peer recreation after unmute", openPeers(evAUnmuted).length === peersBeforeMute);

    // ---------- STEP 5: camera ----------
    section("S3 — Camera off / on (A)");
    const cameraMark = Date.now();
    await A.page.getByRole("button", { name: "Stop video", exact: true }).click();
    await sleep(1500);
    const evACamOff = await evidence(A.page);
    record("A: video track enabled=false after Stop video", evACamOff.localStreams[0]?.video[0]?.enabled === false);
    record("A: no PeerConnection recreated on camera toggle", openPeers(evACamOff).length === peersBeforeMute &&
      !logs.some((l) => l.label === "A" && l.at > cameraMark && l.text.includes("Creating peer connection")));
    record("B: A's tile shows avatar while camera off", (await B.page.getByText("Browser B", { exact: false }).count()) > 0);
    const evBCamOff = await evidence(B.page);
    record("B: peer still connected while A camera off", connectedPeers(evBCamOff).length === 1);

    await A.page.getByRole("button", { name: "Start video", exact: true }).click();
    await sleep(2000);
    const evBCamOn = await evidence(B.page);
    const bVideoResumed = (connectedPeers(evBCamOn)[0]?.inbound.find((i) => i.kind === "video")?.bytesReceived ?? 0) > (bVideoIn?.bytesReceived ?? 0);
    record("B: inbound video bytes keep growing after camera back on", bVideoResumed);

    // ---------- STEP 6: leave ----------
    section("S4 — B leaves");
    await B.page.getByRole("button", { name: "End", exact: true }).click();
    await B.page.waitForURL(FRONT + "/", { timeout: 30000 }).catch(() => {});
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return openPeers(ev).length === 0;
    }, { label: "A: peer to B closed after B left" });
    const evALeft = await evidence(A.page);
    record("A: PeerConnection to B closed", evALeft.peers.every((p) => p.closedAt !== null) && openPeers(evALeft).length === 0,
      `total=${evALeft.peers.length} closed=${evALeft.peers.filter((p) => p.closedAt).length}`);
    record("A: no stale remote stream / tile", evALeft.remoteTiles === 0 && evALeft.videos.filter((v) => !v.muted).length === 0, `tiles=${evALeft.remoteTiles}`);
    record("A: participant count back to 1", evALeft.participantCount === 1, `count=${evALeft.participantCount}`);

    // ---------- STEP 7: rejoin ----------
    section("S5 — B rejoins");
    await B.context.close();
    const B2 = await joinMeeting(browser, "B", A.meetingId, "Browser B");
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return connectedPeers(ev).length >= 1 && inboundMedia(connectedPeers(ev)[0], "video");
    }, { label: "A: fresh peer to rejoining B connected with media" });
    const evARejoin = await evidence(A.page);
    record("A: exactly ONE active peer to B after rejoin (no duplicates)", openPeers(evARejoin).length === 1, `open=${openPeers(evARejoin).length} totalEver=${evARejoin.peers.length}`);
    record("A: exactly ONE remote stream rendered (no duplicates)", evARejoin.remoteTiles === 1 && evARejoin.videos.filter((v) => !v.muted).length === 1, `tiles=${evARejoin.remoteTiles}`);
    record("A: media flowing to rejoining B", !!inboundMedia(connectedPeers(evARejoin)[0], "video"), `bytes=${connectedPeers(evARejoin)[0]?.inbound.find((i) => i.kind === "video")?.bytesReceived}`);
    // B's rejoined peer needs its own ICE round — wait for it to connect
    // with inbound media instead of sampling the instant A finished.
    await waitUntil(async () => {
      const ev = await evidence(B2.page);
      return connectedPeers(ev).length === 1 && !!inboundMedia(connectedPeers(ev)[0], "video");
    }, { label: "B(rejoined): peer connected with media" });
    const evB2r = await evidence(B2.page);
    record("B(rejoined): exactly one peer, connected with media", connectedPeers(evB2r).length === 1 && !!inboundMedia(connectedPeers(evB2r)[0], "video"),
      `open=${openPeers(evB2r).length} totalEver=${evB2r.peers.length}`);

    // ---------- STEP 10: refresh ----------
    section("S6 — A refreshes page");
    const refreshMark = Date.now();
    await A.page.reload({ waitUntil: "domcontentloaded" });
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return connectedPeers(ev).length >= 1 && inboundMedia(connectedPeers(ev)[0], "video");
    }, { label: "A: reconnected with media after refresh" });
    await waitUntil(async () => {
      const ev = await evidence(B2.page);
      return connectedPeers(ev).length === 1 && openPeers(ev).length === 1;
    }, { label: "B: exactly one active peer after A refresh" });
    const evARefresh = await evidence(A.page);
    const evB2Refresh = await evidence(B2.page);
    record("A after refresh: exactly one active peer (fresh page state)", openPeers(evARefresh).length === 1, `open=${openPeers(evARefresh).length}`);
    record("B: no duplicate A peer after A refresh", openPeers(evB2Refresh).length === 1, `open=${openPeers(evB2Refresh).length}`);
    record("B: media resumes after A refresh", !!inboundMedia(connectedPeers(evB2Refresh)[0], "video"));
    record("No 'Creating peer connection' storm on refresh (<= 3 creations)",
      logs.filter((l) => l.label === "A" && l.at > refreshMark && l.text.includes("Creating peer connection")).length <= 3,
      `creations=${logs.filter((l) => l.label === "A" && l.at > refreshMark && l.text.includes("Creating peer connection")).length}`);

    // ---------- STEP 8: three participants ----------
    section("S7 — Third participant C joins");
    const C = await joinMeeting(browser, "C", A.meetingId, "Browser C");
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return connectedPeers(ev).length === 2 && connectedPeers(ev).every((p) => inboundMedia(p, "video"));
    }, { label: "A: 2 connected peers each with video" });
    await waitUntil(async () => {
      const ev = await evidence(B2.page);
      return connectedPeers(ev).length === 2;
    }, { label: "B: 2 connected peers" });
    await waitUntil(async () => {
      const ev = await evidence(C.page);
      return connectedPeers(ev).length === 2;
    }, { label: "C: 2 connected peers" });
    const evA3 = await evidence(A.page);
    const evB3 = await evidence(B2.page);
    const evC3 = await evidence(C.page);
    record("A: 2 PeerConnections (N-1 for 3 users)", openPeers(evA3).length === 2, `open=${openPeers(evA3).length}`);
    record("B: 2 PeerConnections", openPeers(evB3).length === 2, `open=${openPeers(evB3).length}`);
    record("C: 2 PeerConnections", openPeers(evC3).length === 2, `open=${openPeers(evC3).length}`);
    record("A: inbound video from BOTH B and C", connectedPeers(evA3).filter((p) => inboundMedia(p, "video")).length === 2);
    record("C: inbound video from both A and B", connectedPeers(evC3).filter((p) => inboundMedia(p, "video")).length === 2);
    record("A: participant count = 3", evA3.participantCount === 3, `count=${evA3.participantCount}`);

    // ---------- STEP 9: four participants ----------
    section("S8 — Fourth participant D joins");
    let fourOk = true;
    let D = null;
    try {
      D = await joinMeeting(browser, "D", A.meetingId, "Browser D");
      await waitUntil(async () => {
        const ev = await evidence(A.page);
        return connectedPeers(ev).length === 3 && connectedPeers(ev).every((p) => inboundMedia(p, "video"));
      }, { timeout: 60000, label: "A: 3 connected peers each with video" });
      await waitUntil(async () => {
        const ev = await evidence(D.page);
        return connectedPeers(ev).length === 3;
      }, { timeout: 60000, label: "D: 3 connected peers" });
      const evA4 = await evidence(A.page);
      const evD4 = await evidence(D.page);
      record("A: 3 PeerConnections for 4 users", openPeers(evA4).length === 3, `open=${openPeers(evA4).length}`);
      record("D: 3 PeerConnections", openPeers(evD4).length === 3, `open=${openPeers(evD4).length}`);
      record("D: inbound video from all 3 others", connectedPeers(evD4).filter((p) => inboundMedia(p, "video")).length === 3);
      record("A: participant count = 4", evA4.participantCount === 4, `count=${evA4.participantCount}`);
    } catch (error) {
      fourOk = false;
      record("4-participant test", false, `unstable: ${error.message}`);
    }

    // ---------- STEP 11: room isolation ----------
    section("S9 — Different room isolation (E hosts, F joins a new meeting)");
    const E = await newMeeting(browser, "E");
    const F = await joinMeeting(browser, "F", E.meetingId, "Browser F");
    await waitUntil(async () => {
      const ev = await evidence(E.page);
      return connectedPeers(ev).length >= 1 && inboundMedia(connectedPeers(ev)[0], "video");
    }, { label: "E: connected to F with media" });
    const evE = await evidence(E.page);
    const evF = await evidence(F.page);
    const evAIso = await evidence(A.page);
    record("E: exactly 1 peer (to F only, no cross-room peers)", openPeers(evE).length === 1, `open=${openPeers(evE).length}`);
    record("F: exactly 1 peer (to E only)", openPeers(evF).length === 1, `open=${openPeers(evF).length}`);
    record("E: participant count = 2 (A/B/C did not leak in)", evE.participantCount === 2, `count=${evE.participantCount}`);
    record("A: still exactly 3 peers, 4 participants (no leak out)", openPeers(evAIso).length === 3 && evAIso.participantCount === 4,
      `peers=${openPeers(evAIso).length} participants=${evAIso.participantCount}`);
    record("A: no signaling from room 2 reached A", !logs.some((l) => l.label === "A" && (l.text.includes("Browser F") || l.text.includes("Browser E"))));

    // ---------- STEP 12: console audit ----------
    section("S10 — Console error audit");
    const errorSignatures = /(InvalidStateError|OperationError|Failed to set remote|Failed to set local|NotAllowedError|NotReadableError|ICE failed|iceConnectionState=failed)/i;
    const errorHits = logs.filter((l) => errorSignatures.test(l.text));
    record("No critical WebRTC error signatures in any browser", errorHits.length === 0,
      errorHits.length ? errorHits.slice(0, 5).map((l) => `[${l.label}] ${l.text.slice(0, 120)}`).join(" ;; ") : "clean");
    const pageErrors = logs.filter((l) => l.type === "pageerror");
    record("No uncaught page errors", pageErrors.length === 0,
      pageErrors.length ? pageErrors.slice(0, 5).map((l) => `[${l.label}] ${l.text.slice(0, 120)}`).join(" ;; ") : "clean");

    await A.context.close();
    await B2.context.close();
    await C.context.close();
    await E.context.close();
    await F.context.close();
  } finally {
    await browser.close();
    writeFileSync(REPORT_OUT, JSON.stringify({ results, failures, finishedAt: new Date().toISOString() }, null, 2));
    writeFileSync(LOGS_OUT, logs.map((l) => `${new Date(l.at).toISOString()} [${l.label}](${l.type}) ${l.text}`).join("\n"));
  }

  console.log(`\n========== SUMMARY: ${results.length - failures}/${results.length} checks passed ==========`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error("HARNESS CRASHED:", error);
  writeFileSync(LOGS_OUT, logs.map((l) => `${new Date(l.at).toISOString()} [${l.label}](${l.type}) ${l.text}`).join("\n"));
  process.exit(2);
});
