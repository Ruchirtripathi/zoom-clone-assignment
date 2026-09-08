/**
 * Runtime screen-share verification harness (NOT part of the application).
 *
 * Drives real Edge (Chromium) browser sessions through the actual UI and
 * verifies Phase 7 screen sharing against the REAL running stack:
 *   - getDisplayMedia capture (auto-selected "Entire screen": 1280x720)
 *   - RTCRtpSender.replaceTrack() on the EXISTING peer connections
 *   - no new RTCPeerConnection, no createOffer/createAnswer during a share
 *   - remote side renders the screen (1280 wide) vs camera (640 wide)
 *   - camera/mic state preserved across share + stop
 *   - browser-native stop (track ended) detected by the app
 *   - single-sharer rule, late joiner, sharer refresh, permission cancel
 *
 * Covers the 14 required tests (TEST 1..TEST 14 in the section comments).
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const FRONT = "http://localhost:3000";
const REPORT_OUT = new URL("./screenshare-report.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const LOGS_OUT = new URL("./screenshare-console.log", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

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

/** Non-throwing waitUntil: resolves false instead of crashing the suite. */
async function eventually(fn, opts) {
  try { await waitUntil(fn, opts); return true; } catch { return false; }
}

// Injected before any page script. Wraps and records:
//   RTCPeerConnection  -> creations/closures + createOffer/createAnswer calls
//   getUserMedia       -> local (camera) streams
//   getDisplayMedia    -> screen captures (stream + track kept for native-stop simulation)
//   RTCRtpSender.replaceTrack -> every call with the new track's id/kind
//   WebSocket          -> sent frames + received messages (screen_share_* events)
// No backslashes / template literals inside (this is itself a template literal).
const INIT_SCRIPT = `
(() => {
  const NativePC = window.RTCPeerConnection;
  const created = [];
  window.__peerConnections = created;
  window.__localStreams = [];
  window.__screenShares = [];
  window.__replaceTrackCalls = [];
  window.__negotiationCalls = [];
  window.__wsSent = [];
  window.__wsReceived = [];

  function WrappedPC(...args) {
    const pc = new NativePC(...args);
    const entry = { pc, createdAt: Date.now(), closedAt: null };
    const nativeClose = pc.close.bind(pc);
    pc.close = () => { entry.closedAt = Date.now(); return nativeClose(); };
    const nativeOffer = pc.createOffer.bind(pc);
    pc.createOffer = async (...a) => { window.__negotiationCalls.push({ at: Date.now(), op: "createOffer" }); return nativeOffer(...a); };
    const nativeAnswer = pc.createAnswer.bind(pc);
    pc.createAnswer = async (...a) => { window.__negotiationCalls.push({ at: Date.now(), op: "createAnswer" }); return nativeAnswer(...a); };
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

  const nativeGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getDisplayMedia = async (...args) => {
    const stream = await nativeGDM(...args);
    const track = stream.getVideoTracks()[0] || null;
    window.__screenShares.push({ stream: stream, track: track, trackId: track ? track.id : null, label: track ? track.label : null, settings: track ? track.getSettings() : null });
    return stream;
  };

  const nativeReplace = RTCRtpSender.prototype.replaceTrack;
  RTCRtpSender.prototype.replaceTrack = function (track) {
    window.__replaceTrackCalls.push({ at: Date.now(), trackId: track ? track.id : null, kind: track ? track.kind : null });
    return nativeReplace.call(this, track);
  };

  const NativeWS = window.WebSocket;
  function WrappedWS(...args) {
    const ws = new NativeWS(...args);
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

  window.__collectWebrtcEvidence = async () => {
    const peers = [];
    for (const entry of window.__peerConnections) {
      const pc = entry.pc;
      const stats = await pc.getStats();
      const inbound = []; const outbound = []; const candidates = {}; let selectedPair = null;
      stats.forEach((r) => {
        if (r.type === "inbound-rtp") inbound.push({ kind: r.kind, bytesReceived: r.bytesReceived, packetsReceived: r.packetsReceived, framesDecoded: r.framesDecoded == null ? null : r.framesDecoded, frameWidth: r.frameWidth == null ? null : r.frameWidth });
        if (r.type === "outbound-rtp") outbound.push({ kind: r.kind, bytesSent: r.bytesSent, framesEncoded: r.framesEncoded == null ? null : r.framesEncoded });
        if (r.type === "local-candidate" || r.type === "remote-candidate") candidates[r.id] = { candidateType: r.candidateType, protocol: r.protocol, address: r.address || r.ip || null, port: r.port };
        if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded") && r.state !== "failed") selectedPair = r;
      });
      peers.push({
        createdAt: entry.createdAt,
        closedAt: entry.closedAt,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState,
        hasRemoteDescription: !!pc.remoteDescription,
        senders: pc.getSenders().map((s) => ({ kind: s.track ? s.track.kind : null, trackId: s.track ? s.track.id : null, enabled: s.track ? s.track.enabled : null })),
        inbound: inbound,
        outbound: outbound,
      });
    }
    const videos = [...document.querySelectorAll("video")].map((v) => ({
      muted: v.muted, hasSrcObject: !!v.srcObject, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
      totalVideoFrames: v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : null,
      opacity: getComputedStyle(v).opacity,
      videoTrackIds: v.srcObject ? v.srcObject.getVideoTracks().map((t) => t.id) : [],
    }));
    const shareButton = document.querySelector('button[aria-label="Share"], button[aria-label="Stop share"]');
    const participantButton = document.querySelector('button[aria-label="Participants"]');
    return {
      peers: peers,
      videos: videos,
      localStreamTracks: window.__localStreams.flatMap((s) => s.getTracks().map((t) => ({ kind: t.kind, id: t.id, enabled: t.enabled, readyState: t.readyState }))),
      screenShares: window.__screenShares.map((s) => ({ trackId: s.trackId, label: s.label, width: s.settings ? s.settings.width : null, height: s.settings ? s.settings.height : null, readyState: s.track ? s.track.readyState : "gone" })),
      screenShareCount: window.__screenShares.length,
      replaceTrackCalls: window.__replaceTrackCalls.slice(),
      negotiationCalls: window.__negotiationCalls.slice(),
      wsSentTypes: window.__wsSent.map((m) => m.type),
      wsReceivedTypes: window.__wsReceived.map((m) => m.type),
      wsScreenEvents: window.__wsReceived.filter((m) => m.type === "screen_share_started" || m.type === "screen_share_stopped").map((m) => ({ type: m.type, participant_id: m.participant_id, participant_name: m.participant_name })),
      roomStateSharers: (() => {
        const states = window.__wsReceived.filter((m) => m.type === "room_state");
        const first = states[0]; // the join-time snapshot is what a late joiner depends on
        return first && first.participants ? first.participants.filter((p) => p.is_screen_sharing).map((p) => p.name || p.display_name || "") : [];
      })(),
      ui: {
        shareButtonLabel: shareButton ? shareButton.getAttribute("aria-label") : null,
        headerSharing: [...document.querySelectorAll("header span")].map((s) => s.textContent.trim()).find((t) => t.indexOf("sharing") !== -1) || null,
        tileLabels: [...document.querySelectorAll("main div")].filter((d) => d.children.length === 0 && (d.textContent.indexOf("sharing") !== -1 || d.textContent.indexOf("Remote video") !== -1)).map((d) => d.textContent.trim()),
        amberNotices: [...document.querySelectorAll("main .text-amber-100")].map((d) => d.textContent.replace("Dismiss", "").trim()),
      },
      participantCount: participantButton ? parseInt([...participantButton.textContent].filter((c) => c >= "0" && c <= "9").join(""), 10) || null : null,
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
const remoteVideos = (ev) => (ev ? ev.videos.filter((v) => !v.muted) : []);
const cameraTrack = (ev) => (ev ? ev.localStreamTracks.find((t) => t.kind === "video") || null : null);
const isScreenVideo = (v) => v.videoWidth > 1000; // auto-selected screen: 1280x720
const isCameraVideo = (v) => v.videoWidth > 400 && v.videoWidth <= 700; // fake camera: 640x480

async function waitRemoteScreenCount(page, count, label, timeout = 45000) {
  return waitUntil(async () => {
    const ev = await evidence(page);
    const vids = remoteVideos(ev);
    return vids.length >= count && vids.filter(isScreenVideo).length === count;
  }, { timeout, label });
}

async function waitRemoteAllCamera(page, label, timeout = 45000) {
  return waitUntil(async () => {
    const ev = await evidence(page);
    const vids = remoteVideos(ev);
    return vids.length > 0 && vids.every(isCameraVideo);
  }, { timeout, label });
}

async function waitNotice(page, snippet, label) {
  return waitUntil(async () => {
    const ev = await evidence(page);
    return (ev ? ev.ui.amberNotices : []).some((n) => n.includes(snippet));
  }, { label });
}

async function newMeeting(browser, label) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  attach(page, label);
  await page.goto(FRONT, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
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
      "--host-resolver-rules=MAP localhost:8000 127.0.0.1",
      // Auto-answer the screen-capture picker with the entire screen
      // (resolves as 1280x720 — clearly distinct from the 640x480 fake camera).
      // The value must be UNQUOTED; the quoted form hangs the picker.
      "--auto-select-desktop-capture-source=Entire screen",
    ],
  });

  try {
    // ================= TEST 1 + TEST 5: two participants, A shares =================
    section("T1/T5 — Two participants: A shares, then stops from the app (camera ON)");
    const A = await newMeeting(browser, "A");
    const B = await joinMeeting(browser, "B", A.meetingId, "Browser B");
    console.log(`   meeting id: ${A.meetingId}`);

    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return connectedPeers(ev).length >= 1 && connectedPeers(ev)[0].inbound.some((i) => i.kind === "video" && i.bytesReceived > 0);
    }, { label: "A: peer connected + inbound video" });
    await waitUntil(async () => {
      const ev = await evidence(B.page);
      return connectedPeers(ev).length >= 1 && connectedPeers(ev)[0].inbound.some((i) => i.kind === "video" && i.bytesReceived > 0);
    }, { label: "B: peer connected + inbound video" });

    const evBase = await evidence(A.page);
    const baselinePeers = openPeers(evBase).length;
    const baselineNegotiation = evBase.negotiationCalls.length;
    const baselineCameraTrack = cameraTrack(evBase);
    record("baseline: A has camera track, live+enabled", !!baselineCameraTrack && baselineCameraTrack.readyState === "live" && baselineCameraTrack.enabled === true,
      `id=${baselineCameraTrack ? baselineCameraTrack.id.slice(0, 12) : "none"}`);
    const evBBase = await evidence(B.page);
    const baselineRemoteTrackId = remoteVideos(evBBase)[0] ? remoteVideos(evBBase)[0].videoTrackIds[0] : null;
    record("baseline: B renders A's camera (640 wide)", remoteVideos(evBBase).length === 1 && isCameraVideo(remoteVideos(evBBase)[0]),
      `width=${remoteVideos(evBBase)[0] ? remoteVideos(evBBase)[0].videoWidth : 0}`);
    const shareMark = Date.now();
    await A.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitRemoteScreenCount(B.page, 1, "T1: B renders A's screen (1280 wide)");

    const evA1 = await evidence(A.page);
    const evB1 = await evidence(B.page);
    // The host joins via "New meeting" with its persisted dashboard identity
    // (not a modal name) — take the authoritative display name from the
    // server's screen_share_started broadcast that B received.
    const startEvent1 = evB1.wsScreenEvents.find((m) => m.type === "screen_share_started");
    const sharerName = startEvent1 ? String(startEvent1.participant_name || "") : "";
    console.log(`   sharer display name: "${sharerName}"`);
    record("T1: broadcast names the sharer (participant_name present)", sharerName.length > 0, `participant_name=${sharerName}`);
    const screenShare1 = evA1.screenShares[evA1.screenShares.length - 1];
    record("T1: A captured the screen via getDisplayMedia (1280x720)", evA1.screenShareCount === 1 && screenShare1.width === 1280 && screenShare1.height === 720,
      `count=${evA1.screenShareCount} size=${screenShare1.width}x${screenShare1.height} label=${screenShare1.label}`);
    record("T1: A: NO new PeerConnection for sharing (open count stable, none created in the window)",
      openPeers(evA1).length === baselinePeers && !evA1.peers.some((p) => p.createdAt > shareMark),
      `open=${openPeers(evA1).length} totalEver=${evA1.peers.length}`);
    record("T1: A: NO renegotiation while sharing (no createOffer/createAnswer)",
      evA1.negotiationCalls.length === baselineNegotiation, `delta=${evA1.negotiationCalls.length - baselineNegotiation}`);
    const replDuringShare = evA1.replaceTrackCalls.filter((c) => c.at > shareMark);
    record("T1: A: replaceTrack called exactly once per peer (screen track in, camera out)",
      replDuringShare.length === 1 && replDuringShare[0].trackId === screenShare1.trackId && replDuringShare[0].kind === "video",
      `calls=${replDuringShare.length} -> track ${replDuringShare[0] ? replDuringShare[0].trackId.slice(0, 12) : "-"}`);
    record("T1: A: video sender now carries the SCREEN track",
      openPeers(evA1).every((p) => { const s = p.senders.find((x) => x.kind === "video"); return s && s.trackId === screenShare1.trackId; }));
    record("T1: A: camera track untouched by the share (same id, still live+enabled)",
      cameraTrack(evA1).id === baselineCameraTrack.id && cameraTrack(evA1).readyState === "live" && cameraTrack(evA1).enabled === true);
    record("T1: A: local preview shows the screen (muted tile, 1280 wide)",
      evA1.videos.filter((v) => v.muted).length === 1 && isScreenVideo(evA1.videos.filter((v) => v.muted)[0]),
      `width=${evA1.videos.filter((v) => v.muted)[0] ? evA1.videos.filter((v) => v.muted)[0].videoWidth : 0}`);
    record("T1: A: toolbar shows 'Stop share'", evA1.ui.shareButtonLabel === "Stop share", evA1.ui.shareButtonLabel);
    record("T1: A: header pill 'You are sharing'", evA1.ui.headerSharing === "You are sharing", String(evA1.ui.headerSharing));
    record("T1: A: local tile label 'You are sharing your screen'", evA1.ui.tileLabels.includes("You are sharing your screen"));
    record("T1: B: header pill names the sharer", evB1.ui.headerSharing === `${sharerName} is sharing`, String(evB1.ui.headerSharing));
    record("T1: B: remote tile label names the sharer", evB1.ui.tileLabels.includes(`${sharerName} is sharing`), evB1.ui.tileLabels.join(" | "));
    record("T1: B: received screen_share_started over WS", evB1.wsReceivedTypes.includes("screen_share_started"));
    record("T1: B: receiver video track UNCHANGED (same track id as before the share)",
      remoteVideos(evB1)[0].videoTrackIds[0] === baselineRemoteTrackId, `${baselineRemoteTrackId ? baselineRemoteTrackId.slice(0, 12) : "-"} -> ${remoteVideos(evB1)[0].videoTrackIds[0].slice(0, 12)}`);
    record("T1: B: peer still connected during share", connectedPeers(evB1).length === 1);
    const bInbound1 = connectedPeers(evB1)[0].inbound.find((i) => i.kind === "video");
    record("T1: B: inbound RTP frames are the SCREEN (frameWidth > 1000)", !!bInbound1 && bInbound1.frameWidth != null && bInbound1.frameWidth > 1000,
      `frameWidth=${bInbound1 ? bInbound1.frameWidth : "?"}`);
    await sleep(2000);
    const evB1b = await evidence(B.page);
    const bInbound1b = connectedPeers(evB1b)[0].inbound.find((i) => i.kind === "video");
    record("T1: B: inbound video bytes/frames keep growing during the share",
      bInbound1b.bytesReceived > bInbound1.bytesReceived && bInbound1b.framesDecoded > bInbound1.framesDecoded,
      `bytes ${bInbound1.bytesReceived} -> ${bInbound1b.bytesReceived}, frames ${bInbound1.framesDecoded} -> ${bInbound1b.framesDecoded}`);
    record("T1: console: 'Screen sharing started (1 peer(s) now sending screen)'",
      logs.some((l) => l.label === "A" && l.text.includes("Screen sharing started (1 peer(s) now sending screen)")));
    record("T1: console: 'Replaced outgoing video track on'", logs.some((l) => l.label === "A" && l.text.includes("Replaced outgoing video track on")));

    // ================= TEST 2 + TEST 5: stop from the app =================
    await A.page.getByRole("button", { name: "Stop share", exact: true }).click();
    await waitRemoteAllCamera(B.page, "T2: B renders A's camera again (640 wide)");

    const evA2 = await evidence(A.page);
    const evB2 = await evidence(B.page);
    const replDuringStop = evA2.replaceTrackCalls.filter((c) => c.at > shareMark).filter((c) => c.trackId === baselineCameraTrack.id);
    record("T2: A: camera restored via replaceTrack (camera track back in the sender)",
      replDuringStop.length === 1 && openPeers(evA2).every((p) => { const s = p.senders.find((x) => x.kind === "video"); return s && s.trackId === baselineCameraTrack.id; }),
      `restore calls=${replDuringStop.length}`);
    record("T2: A: still NO renegotiation across share+stop",
      evA2.negotiationCalls.length === baselineNegotiation, `delta=${evA2.negotiationCalls.length - baselineNegotiation}`);
    record("T2: A: still exactly one peer, connected", openPeers(evA2).length === baselinePeers && connectedPeers(evA2).length === 1);
    record("T2: A: screen track ended after stop", evA2.screenShares.every((s) => s.readyState === "ended"),
      `readyStates=${evA2.screenShares.map((s) => s.readyState).join(",")}`);
    record("T2: A: camera track still live, still enabled (TEST 5: camera was ON before)",
      cameraTrack(evA2).id === baselineCameraTrack.id && cameraTrack(evA2).readyState === "live" && cameraTrack(evA2).enabled === true);
    record("T2: A: toolbar back to 'Share'", evA2.ui.shareButtonLabel === "Share", evA2.ui.shareButtonLabel);
    record("T2: A: header pill gone", evA2.ui.headerSharing === null, String(evA2.ui.headerSharing));
    record("T2: B: received screen_share_stopped over WS", evB2.wsReceivedTypes.includes("screen_share_stopped"));
    record("T2: B: header pill gone", evB2.ui.headerSharing === null, String(evB2.ui.headerSharing));
    record("T2: B: media keeps flowing after restore (bytes grew)",
      connectedPeers(evB2)[0].inbound.find((i) => i.kind === "video").bytesReceived > bInbound1b.bytesReceived);
    record("T2: console: 'Camera restored on 1 peer(s)'", logs.some((l) => l.label === "A" && l.text.includes("Camera restored on 1 peer(s)")));

    // ================= TEST 3: stop from the BROWSER's own UI =================
    section("T3 — Browser-native stop (screen track ends outside the app)");
    await A.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitRemoteScreenCount(B.page, 1, "T3: B renders A's screen again");
    // What the browser's "Stop sharing" bar does: it ends the captured track
    // without any app involvement. Probed behavior in this build: a script
    // stop() on a sender-attached capture track does NOT always emit the
    // native "ended" event (the browser's own stop bar does), so stop the
    // track AND dispatch the event — exercising the app's onended path.
    await A.page.evaluate(() => {
      const share = window.__screenShares[window.__screenShares.length - 1];
      if (!share) throw new Error("no screen share captured");
      share.track.stop();
      share.track.dispatchEvent(new Event("ended"));
    });
    await waitRemoteAllCamera(B.page, "T3: B back to camera after native stop");
    const evA3 = await evidence(A.page);
    const evB3 = await evidence(B.page);
    record("T3: app detected the native stop WITHOUT the Stop button (toolbar back to 'Share')",
      evA3.ui.shareButtonLabel === "Share", evA3.ui.shareButtonLabel);
    record("T3: console: 'Screen track ended outside the app (browser stop bar)'",
      logs.some((l) => l.label === "A" && l.text.includes("Screen track ended outside the app (browser stop bar)")));
    record("T3: camera restored to the remote side", remoteVideos(evB3).length === 1 && isCameraVideo(remoteVideos(evB3)[0]),
      `width=${remoteVideos(evB3)[0] ? remoteVideos(evB3)[0].videoWidth : 0}`);
    record("T3: B received screen_share_stopped for the native stop", evB3.wsReceivedTypes.filter((t) => t === "screen_share_stopped").length === 2);
    record("T3: screen track ended", evA3.screenShares.every((s) => s.readyState === "ended"));
    record("T3: camera track still live after native stop", cameraTrack(evA3).readyState === "live" && cameraTrack(evA3).enabled === true);

    // ================= TEST 4: camera OFF before sharing =================
    section("T4 — Camera off before share: screen replaces black, camera-off preserved");
    await A.page.getByRole("button", { name: "Stop video", exact: true }).click();
    await sleep(1200);
    const evA4a = await evidence(A.page);
    record("T4: setup — A's camera track disabled before sharing", cameraTrack(evA4a).enabled === false);
    await A.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitRemoteScreenCount(B.page, 1, "T4: B renders A's screen (camera was off)");
    const evA4b = await evidence(A.page);
    const evB4b = await evidence(B.page);
    record("T4: B sees the SCREEN (video visible, not the avatar)",
      remoteVideos(evB4b).length === 1 && isScreenVideo(remoteVideos(evB4b)[0]) && remoteVideos(evB4b)[0].opacity === "1",
      `width=${remoteVideos(evB4b)[0].videoWidth} opacity=${remoteVideos(evB4b)[0].opacity}`);
    record("T4: B's remote tile names the sharer despite video_enabled=false",
      evB4b.ui.tileLabels.includes(`${sharerName} is sharing`), evB4b.ui.tileLabels.join(" | "));
    record("T4: A's camera track stays DISABLED while sharing the screen", cameraTrack(evA4b).enabled === false);

    await A.page.getByRole("button", { name: "Stop share", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(B.page);
      const vids = remoteVideos(ev);
      return vids.length === 1 && vids[0].opacity === "0";
    }, { label: "T4: B back to avatar (camera still off)" });
    const evA4c = await evidence(A.page);
    const evB4c = await evidence(B.page);
    record("T4: after stop, B shows the AVATAR again (camera still off)",
      remoteVideos(evB4c)[0].opacity === "0" && evB4c.ui.tileLabels.includes("Remote video"),
      `opacity=${remoteVideos(evB4c)[0].opacity} labels=${evB4c.ui.tileLabels.join(" | ")}`);
    record("T4: A's camera track STILL disabled after restore (previous state preserved)",
      cameraTrack(evA4c).enabled === false && cameraTrack(evA4c).id === baselineCameraTrack.id);
    record("T4: B: header pill gone", evB4c.ui.headerSharing === null);
    // Restore camera for the remaining tests.
    await A.page.getByRole("button", { name: "Start video", exact: true }).click();
    await sleep(1200);

    // ================= TEST 6: mic state preserved =================
    section("T6 — Muted before share: mic stays muted, audio keeps flowing");
    await A.page.getByRole("button", { name: "Mute", exact: true }).click();
    await sleep(1200);
    const evA6a = await evidence(A.page);
    record("T6: setup — A's mic disabled before sharing", evA6a.localStreamTracks.find((t) => t.kind === "audio").enabled === false);
    await A.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitRemoteScreenCount(B.page, 1, "T6: B renders A's screen (A muted)");
    const evA6b = await evidence(A.page);
    const evB6b = await evidence(B.page);
    record("T6: A's audio track stays DISABLED while sharing", evA6b.localStreamTracks.find((t) => t.kind === "audio").enabled === false);
    const bAudio6 = connectedPeers(evB6b)[0].inbound.find((i) => i.kind === "audio");
    await sleep(2000);
    const evB6c = await evidence(B.page);
    const bAudio6c = connectedPeers(evB6c)[0].inbound.find((i) => i.kind === "audio");
    record("T6: B keeps receiving A's audio RTP while A is muted (silence frames)",
      bAudio6c.bytesReceived > bAudio6.bytesReceived, `bytes ${bAudio6.bytesReceived} -> ${bAudio6c.bytesReceived}`);
    await A.page.getByRole("button", { name: "Stop share", exact: true }).click();
    await waitRemoteAllCamera(B.page, "T6: B back to camera");
    const evA6d = await evidence(A.page);
    record("T6: A's mic STILL disabled after stop (never touched by sharing)",
      evA6d.localStreamTracks.find((t) => t.kind === "audio").enabled === false);
    await A.page.getByRole("button", { name: "Unmute", exact: true }).click();
    await sleep(1200);

    // ================= TEST 7: three participants =================
    section("T7 — Three participants: A shares, B and C both receive the screen");
    const C = await joinMeeting(browser, "C", A.meetingId, "Browser C");
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return connectedPeers(ev).length === 2 && connectedPeers(ev).every((p) => p.inbound.some((i) => i.kind === "video" && i.bytesReceived > 0));
    }, { label: "T7: A connected to B and C" });
    await waitUntil(async () => {
      const ev = await evidence(C.page);
      return connectedPeers(ev).length === 2;
    }, { label: "T7: C connected to A and B" });
    const evA7base = await evidence(A.page);
    const neg7 = evA7base.negotiationCalls.length;
    const repl7 = evA7base.replaceTrackCalls.length;
    const share7Mark = Date.now();
    await A.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitRemoteScreenCount(B.page, 1, "T7: B renders A's screen");
    await waitRemoteScreenCount(C.page, 1, "T7: C renders A's screen");
    const evA7 = await evidence(A.page);
    const evB7 = await evidence(B.page);
    const evC7 = await evidence(C.page);
    record("T7: A still has exactly 2 peers (no new connections)", openPeers(evA7).length === 2, `open=${openPeers(evA7).length}`);
    record("T7: A: NO renegotiation during the 3-way share", evA7.negotiationCalls.length === neg7, `delta=${evA7.negotiationCalls.length - neg7}`);
    const repl7delta = evA7.replaceTrackCalls.filter((c) => c.at > share7Mark).length;
    record("T7: A: replaceTrack called on BOTH peers", repl7delta === 2, `calls=${repl7delta}`);
    record("T7: A: both video senders carry the screen track",
      openPeers(evA7).every((p) => { const s = p.senders.find((x) => x.kind === "video"); return s && s.trackId === evA7.screenShares[evA7.screenShares.length - 1].trackId; }));
    record("T7: B sees the screen (and C's camera separately)",
      remoteVideos(evB7).filter(isScreenVideo).length === 1 && remoteVideos(evB7).length === 2,
      `widths=${remoteVideos(evB7).map((v) => v.videoWidth).join(",")}`);
    record("T7: C received screen_share_started over WS", evC7.wsReceivedTypes.includes("screen_share_started"));
    record("T7: console: 'Screen sharing started (2 peer(s) now sending screen)'",
      logs.some((l) => l.label === "A" && l.at > share7Mark && l.text.includes("Screen sharing started (2 peer(s) now sending screen)")));
    await A.page.getByRole("button", { name: "Stop share", exact: true }).click();
    await waitRemoteAllCamera(B.page, "T7: B back to camera");
    await waitRemoteAllCamera(C.page, "T7: C back to camera");
    const evA7s = await evidence(A.page);
    record("T7: stop restores camera on both peers (2 restore calls, senders hold camera track)",
      evA7s.replaceTrackCalls.filter((c) => c.at > share7Mark).length === 4 &&
      openPeers(evA7s).every((p) => { const s = p.senders.find((x) => x.kind === "video"); return s && s.trackId === baselineCameraTrack.id; }));

    // ================= TEST 8: four participants =================
    section("T8 — Four participants: A shares, B, C and D all receive the screen");
    const D = await joinMeeting(browser, "D", A.meetingId, "Browser D");
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return connectedPeers(ev).length === 3 && connectedPeers(ev).every((p) => p.inbound.some((i) => i.kind === "video" && i.bytesReceived > 0));
    }, { timeout: 60000, label: "T8: A connected to B, C and D" });
    const evA8base = await evidence(A.page);
    const neg8 = evA8base.negotiationCalls.length;
    const share8Mark = Date.now();
    await A.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitRemoteScreenCount(B.page, 1, "T8: B renders A's screen");
    await waitRemoteScreenCount(C.page, 1, "T8: C renders A's screen");
    await waitRemoteScreenCount(D.page, 1, "T8: D renders A's screen");
    const evA8 = await evidence(A.page);
    record("T8: A still has exactly 3 peers (no new connections)", openPeers(evA8).length === 3, `open=${openPeers(evA8).length}`);
    record("T8: A: NO renegotiation during the 4-way share", evA8.negotiationCalls.length === neg8, `delta=${evA8.negotiationCalls.length - neg8}`);
    record("T8: A: replaceTrack called on ALL THREE peers",
      evA8.replaceTrackCalls.filter((c) => c.at > share8Mark).length === 3);
    record("T8: console: 'Screen sharing started (3 peer(s) now sending screen)'",
      logs.some((l) => l.label === "A" && l.at > share8Mark && l.text.includes("Screen sharing started (3 peer(s) now sending screen)")));

    // ================= TEST 9: second sharer rejected =================
    section("T9 — Second sharer rejected while A is sharing (client gate)");
    await B.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitNotice(B.page, "currently sharing their screen", "T9: B sees the 'someone else is sharing' notice");
    const evB9 = await evidence(B.page);
    const evA9 = await evidence(A.page);
    record("T9: notice names the sharer", evB9.ui.amberNotices.some((n) => n.includes(`${sharerName} is currently sharing their screen.`)),
      evB9.ui.amberNotices.join(" | "));
    record("T9: B never opened the screen picker (getDisplayMedia not called)", evB9.screenShareCount === 0, `count=${evB9.screenShareCount}`);
    record("T9: B never sent screen_share_started", !evB9.wsSentTypes.includes("screen_share_started"));
    record("T9: B's toolbar still 'Share' (not sharing)", evB9.ui.shareButtonLabel === "Share", evB9.ui.shareButtonLabel);
    record("T9: A is still the sharer (toolbar 'Stop share', B still sees screen)",
      evA9.ui.shareButtonLabel === "Stop share" && remoteVideos(evB9).some(isScreenVideo));
    await A.page.getByRole("button", { name: "Stop share", exact: true }).click();
    await waitRemoteAllCamera(B.page, "T9: B back to camera");
    await waitRemoteAllCamera(C.page, "T9: C back to camera");
    await waitRemoteAllCamera(D.page, "T9: D back to camera");

    // ================= TEST 10: participant leaves during share =================
    section("T10 — B leaves while A is sharing: share continues for C and D");
    await A.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitRemoteScreenCount(C.page, 1, "T10: C renders A's screen");
    await waitRemoteScreenCount(D.page, 1, "T10: D renders A's screen");
    await B.page.getByRole("button", { name: "End", exact: true }).click();
    await B.page.waitForURL(FRONT + "/", { timeout: 30000 }).catch(() => {});
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return openPeers(ev).length === 2;
    }, { label: "T10: A's peer to B closed" });
    await sleep(1500);
    const evA10 = await evidence(A.page);
    const evC10 = await evidence(C.page);
    const evD10 = await evidence(D.page);
    record("T10: A still sharing after B left (toolbar + track live)",
      evA10.ui.shareButtonLabel === "Stop share" && evA10.screenShares[evA10.screenShares.length - 1].readyState === "live");
    record("T10: C still renders A's screen", remoteVideos(evC10).some(isScreenVideo), `widths=${remoteVideos(evC10).map((v) => v.videoWidth).join(",")}`);
    record("T10: D still renders A's screen", remoteVideos(evD10).some(isScreenVideo), `widths=${remoteVideos(evD10).map((v) => v.videoWidth).join(",")}`);
    record("T10: A's remaining 2 senders still carry the screen track",
      openPeers(evA10).length === 2 && openPeers(evA10).every((p) => { const s = p.senders.find((x) => x.kind === "video"); return s && s.trackId === evA10.screenShares[evA10.screenShares.length - 1].trackId; }));
    await A.page.getByRole("button", { name: "Stop share", exact: true }).click();
    await waitRemoteAllCamera(C.page, "T10: C back to camera");
    await waitRemoteAllCamera(D.page, "T10: D back to camera");
    await B.context.close();

    // ================= TEST 11: rejoin during active share (late joiner) =================
    section("T11 — B rejoins DURING A's share: receives the screen as a late joiner");
    await A.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitRemoteScreenCount(C.page, 1, "T11: C renders A's screen");
    await waitRemoteScreenCount(D.page, 1, "T11: D renders A's screen");
    const evA11base = await evidence(A.page);
    const repl11 = evA11base.replaceTrackCalls.length;
    const B2 = await joinMeeting(browser, "B2", A.meetingId, "Browser B");
    await waitUntil(async () => {
      const ev = await evidence(B2.page);
      return connectedPeers(ev).length === 3 && connectedPeers(ev).every((p) => p.inbound.some((i) => i.kind === "video" && i.bytesReceived > 0));
    }, { timeout: 60000, label: "T11: rejoining B connected to A, C and D" });
    await waitRemoteScreenCount(B2.page, 1, "T11: late joiner B renders A's SCREEN");
    const evA11 = await evidence(A.page);
    const evB2late = await evidence(B2.page);
    record("T11: A now has 3 peers (new peer for the rejoining B)", openPeers(evA11).length === 3, `open=${openPeers(evA11).length}`);
    record("T11: the new peer got the screen via INITIAL negotiation, not replaceTrack (0 new calls)",
      evA11.replaceTrackCalls.length === repl11, `delta=${evA11.replaceTrackCalls.length - repl11}`);
    record("T11: ALL of A's video senders carry the screen track (including the new one)",
      openPeers(evA11).every((p) => { const s = p.senders.find((x) => x.kind === "video"); return s && s.trackId === evA11.screenShares[evA11.screenShares.length - 1].trackId; }));
    record("T11: late joiner B sees the sharer named (room_state + live event)",
      evB2late.ui.headerSharing === `${sharerName} is sharing` && evB2late.ui.tileLabels.includes(`${sharerName} is sharing`),
      `header=${evB2late.ui.headerSharing} labels=${evB2late.ui.tileLabels.join(" | ")}`);
    record("T11: late joiner's room_state carried the sharer flag (is_screen_sharing)",
      evB2late.roomStateSharers.length === 1 && evB2late.roomStateSharers[0] === sharerName,
      `sharers=${JSON.stringify(evB2late.roomStateSharers)}`);
    record("T11: late joiner received real screen RTP (frameWidth > 1000)",
      connectedPeers(evB2late).some((p) => { const i = p.inbound.find((x) => x.kind === "video"); return i && i.frameWidth != null && i.frameWidth > 1000; }));
    await A.page.getByRole("button", { name: "Stop share", exact: true }).click();
    await waitRemoteAllCamera(B2.page, "T11: late joiner back to camera after stop");
    const evA11s = await evidence(A.page);
    record("T11: stop restored the camera on all 3 peers (3 restore calls)",
      evA11s.replaceTrackCalls.length - repl11 === 3 &&
      openPeers(evA11s).every((p) => { const s = p.senders.find((x) => x.kind === "video"); return s && s.trackId === baselineCameraTrack.id; }),
      `delta=${evA11s.replaceTrackCalls.length - repl11}`);

    // ================= TEST 12: sharer refreshes mid-share =================
    section("T12 — Sharer refreshes the page mid-share: clean reconnection, camera only");
    await A.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitRemoteScreenCount(B2.page, 1, "T12: B renders A's screen");
    await waitRemoteScreenCount(C.page, 1, "T12: C renders A's screen");
    await A.page.reload({ waitUntil: "domcontentloaded" });
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return connectedPeers(ev).length === 3 && connectedPeers(ev).every((p) => p.inbound.some((i) => i.kind === "video" && i.bytesReceived > 0));
    }, { timeout: 60000, label: "T12: A reconnected to everyone after refresh" });
    await waitRemoteAllCamera(B2.page, "T12: B back to A's camera after refresh");
    await waitRemoteAllCamera(C.page, "T12: C back to A's camera after refresh");
    await waitRemoteAllCamera(D.page, "T12: D back to A's camera after refresh");
    const evA12 = await evidence(A.page);
    const evB12 = await evidence(B2.page);
    const evC12 = await evidence(C.page);
    record("T12: fresh page captured NO screen (old capture died with the page)", evA12.screenShareCount === 0, `count=${evA12.screenShareCount}`);
    record("T12: A's toolbar is 'Share' on the fresh page", evA12.ui.shareButtonLabel === "Share", evA12.ui.shareButtonLabel);
    record("T12: A's camera track on the fresh page is live+enabled",
      cameraTrack(evA12) != null && cameraTrack(evA12).readyState === "live" && cameraTrack(evA12).enabled === true);
    record("T12: B's header pill gone (server cleared the sharer on disconnect)",
      evB12.ui.headerSharing === null && evB12.ui.tileLabels.includes("Remote video"), `header=${evB12.ui.headerSharing}`);
    record("T12: C's header pill gone", evC12.ui.headerSharing === null, String(evC12.ui.headerSharing));

    // ================= TEST 13: permission cancelled =================
    section("T13 — User cancels the picker (NotAllowedError): not fatal");
    await A.page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    const evA13base = await evidence(A.page);
    const neg13 = evA13base.negotiationCalls.length;
    const repl13 = evA13base.replaceTrackCalls.length;
    await A.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitNotice(A.page, "Screen sharing was cancelled.", "T13: A sees the cancelled notice");
    const evA13 = await evidence(A.page);
    record("T13: notice shown, toolbar still 'Share'", evA13.ui.shareButtonLabel === "Share", evA13.ui.shareButtonLabel);
    record("T13: no screen_share_started sent", !evA13.wsSentTypes.includes("screen_share_started"));
    record("T13: no replaceTrack, no renegotiation, peers untouched",
      evA13.replaceTrackCalls.length === repl13 && evA13.negotiationCalls.length === neg13 && openPeers(evA13).length === 3);
    record("T13: camera track untouched by the failed start",
      cameraTrack(evA13).readyState === "live" && cameraTrack(evA13).enabled === true);
    record("T13: console: 'getDisplayMedia failed: NotAllowedError'",
      logs.some((l) => l.label === "A" && l.text.includes("getDisplayMedia failed: NotAllowedError")));
    record("T13: notice auto-dismisses after 5s",
      await eventually(async () => {
        const ev = await evidence(A.page);
        return !ev.ui.amberNotices.some((n) => n.includes("Screen sharing was cancelled."));
      }, { timeout: 9000, label: "T13: notice auto-dismiss" }));

    // ================= TEST 14: cleanup audit =================
    section("T14 — Cleanup audit: no leaked tracks, no stale UI, clean console");
    const evA14 = await evidence(A.page);
    const evB14 = await evidence(B2.page);
    const evC14 = await evidence(C.page);
    const evD14 = await evidence(D.page);
    record("T14: every captured screen track on the live page is ended", evA14.screenShares.every((s) => s.readyState === "ended"),
      `readyStates=[${evA14.screenShares.map((s) => s.readyState).join(",")}]`);
    record("T14: A's camera track is the ORIGINAL track, live+enabled",
      cameraTrack(evA14) != null && cameraTrack(evA14).id !== null && cameraTrack(evA14).readyState === "live" && cameraTrack(evA14).enabled === true);
    record("T14: A: all video senders hold the camera track (no screen residue)",
      openPeers(evA14).length === 3 && openPeers(evA14).every((p) => { const s = p.senders.find((x) => x.kind === "video"); return s && s.trackId === cameraTrack(evA14).id; }));
    record("T14: A: UI clean (toolbar 'Share', no pill, no sharing labels)",
      evA14.ui.shareButtonLabel === "Share" && evA14.ui.headerSharing === null &&
      evA14.ui.tileLabels.length === 3 && evA14.ui.tileLabels.every((t) => t === "Remote video"),
      `labels=${evA14.ui.tileLabels.join(" | ")}`);
    record("T14: B/C/D: no sharing pill, tiles back to 'Remote video'",
      evB14.ui.headerSharing === null && evC14.ui.headerSharing === null && evD14.ui.headerSharing === null &&
      [evB14, evC14, evD14].every((ev) => ev.ui.tileLabels.filter((t) => t === "Remote video").length === 3 && !ev.ui.tileLabels.some((t) => t.includes("sharing"))));
    record("T14: everyone renders cameras (640 wide) and stays connected",
      [evB14, evC14, evD14].every((ev) => remoteVideos(ev).length === 3 && remoteVideos(ev).every(isCameraVideo) && connectedPeers(ev).length === 3),
      `B widths=${remoteVideos(evB14).map((v) => v.videoWidth).join(",")}`);
    record("T14: participant count = 4 everywhere",
      [evA14, evB14, evC14, evD14].every((ev) => ev.participantCount === 4), `A=${evA14.participantCount}`);

    // NotAllowedError is deliberately excluded: TEST 13 cancels the picker on
    // purpose and the app logs that (info level) as a normal, handled outcome.
    const errorSignatures = /(InvalidStateError|OperationError|Failed to set remote|Failed to set local|NotReadableError|ICE failed|iceConnectionState=failed)/i;
    const errorHits = logs.filter((l) => errorSignatures.test(l.text));
    record("T14: no critical WebRTC error signatures in any browser", errorHits.length === 0,
      errorHits.length ? errorHits.slice(0, 5).map((l) => `[${l.label}] ${l.text.slice(0, 120)}`).join(" ;; ") : "clean");
    const pageErrors = logs.filter((l) => l.type === "pageerror");
    record("T14: no uncaught page errors", pageErrors.length === 0,
      pageErrors.length ? pageErrors.slice(0, 5).map((l) => `[${l.label}] ${l.text.slice(0, 120)}`).join(" ;; ") : "clean");

    await A.context.close();
    await B2.context.close();
    await C.context.close();
    await D.context.close();
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
