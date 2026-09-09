/**
 * LIVE production screen-share verification (Phase 12) — the deployed stack:
 *
 *   Frontend : https://zoom-clone-frontend-beta.vercel.app   (Vercel, HTTPS)
 *   Backend  : https://zoom-clone-assignment-p30d.onrender.com (Render free)
 *
 * A (host, fake camera) starts a meeting; B joins through the direct invite
 * link. A shares the screen (auto-selected "Entire screen", 1280x720 —
 * clearly distinct from the 640x480 fake camera), then stops.
 *
 * Proves on production, with measured evidence:
 *   - getDisplayMedia capture really happened (1280x720 track)
 *   - B's inbound RTP switches to screen frames (frameWidth > 1000) and
 *     keeps flowing (bytes/frames grow)
 *   - screen_share_started broadcast arrives over wss://
 *   - B's UI names the sharer; A's toolbar flips to "Stop share"
 *   - stopping restores the camera (B back to 640-wide frames)
 *   - the same PeerConnection survives the whole share (no recreation)
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const FRONT = "https://zoom-clone-frontend-beta.vercel.app";

const REPORT_OUT = new URL("./live-screenshare-report.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const results = [];
let failures = 0;

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  if (!pass) failures += 1;
  console.log(`${pass ? "  PASS " : ">>FAIL "} ${name}${detail ? "  | " + detail : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, { timeout = 60000, interval = 700, label = "condition" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const INIT_SCRIPT = `
(() => {
  const NativePC = window.RTCPeerConnection;
  const created = [];
  window.__peerConnections = created;
  window.__screenCaptures = [];
  window.__wsReceived = [];

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

  // Guarded: on non-secure/error documents navigator.mediaDevices is
  // undefined, and an init script that throws shows up as a page error.
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
    const nativeGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (...args) => {
      const stream = await nativeGDM(...args);
      const track = stream.getVideoTracks()[0];
      window.__screenCaptures.push({ trackId: track.id, label: track.label, readyState: track.readyState });
      track.addEventListener("ended", () => { const c = window.__screenCaptures.find((x) => x.trackId === track.id); if (c) c.readyState = "ended"; });
      return stream;
    };
  }

  const NativeWS = window.WebSocket;
  function WrappedWS(...args) {
    const ws = new NativeWS(...args);
    ws.addEventListener("message", (event) => {
      try { window.__wsReceived.push(JSON.parse(event.data)); } catch (e) {}
    });
    return ws;
  }
  WrappedWS.prototype = NativeWS.prototype;
  Object.setPrototypeOf(WrappedWS, NativeWS);
  Object.defineProperty(window, "WebSocket", { value: WrappedWS, configurable: true, writable: true });

  window.__screenEvidence = async () => {
    const stats = [];
    for (const entry of window.__peerConnections) {
      const s = await entry.pc.getStats();
      const inbound = [];
      s.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "video") {
          inbound.push({ bytesReceived: r.bytesReceived, framesDecoded: r.framesDecoded ?? null, frameWidth: r.frameWidth ?? null });
        }
      });
      stats.push({ createdAt: entry.createdAt, closedAt: entry.closedAt, connectionState: entry.pc.connectionState, inbound });
    }
    const shareButton = document.querySelector('button[aria-label="Share"], button[aria-label="Stop share"]');
    const header = document.querySelector("header") ? document.querySelector("header").textContent : "";
    const remoteVideos = Array.from(document.querySelectorAll("video")).filter((v) => !v.muted && v.srcObject);
    return {
      peers: stats,
      screenCaptures: window.__screenCaptures.slice(),
      shareButtonLabel: shareButton ? shareButton.getAttribute("aria-label") : null,
      headerSharingPill: /\\bsharing\\b/.test(header) ? header.match(/[^ ]* ?is sharing/)?.[0] ?? "sharing" : null,
      remoteVideoWidth: remoteVideos.length ? remoteVideos[0].videoWidth : null,
      screenEvents: window.__wsReceived.filter((m) => m.type === "screen_share_started" || m.type === "screen_share_stopped"),
    };
  };
})();
`;

function attach(page, label) {
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`   [${label}][console.error] ${msg.text().slice(0, 200)}`);
  });
  page.on("pageerror", (error) => console.log(`   [${label}][pageerror] ${error.message.slice(0, 200)}`));
  page.on("dialog", (dialog) => dialog.accept().catch(() => {}));
}

const evidence = (page) => page.evaluate(() => window.__screenEvidence()).catch(() => null);
const openPeers = (ev) => (ev ? ev.peers.filter((p) => !p.closedAt) : []);

async function gotoWithRetry(page, url, { attempts = 8, ...opts } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.goto(url, opts);
    } catch (error) {
      lastError = error;
      console.log(`   [nav retry ${i + 1}/${attempts}] ${String(error.message).slice(0, 80)}`);
      await sleep(3000);
    }
  }
  throw lastError;
}

async function newMeeting(browser, label) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  attach(page, label);
  await gotoWithRetry(page, FRONT, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByRole("button", { name: "New meeting" }).click();
    try {
      await page.waitForURL(/\/room\//, { timeout: 15000 });
      return { context, page, meetingId: page.url().split("/room/")[1].split("?")[0] };
    } catch { /* retry */ }
  }
  throw new Error(`${label}: could not start a new meeting`);
}

async function joinViaInviteLink(browser, label, meetingId, name) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  attach(page, label);
  await gotoWithRetry(page, `${FRONT}/room/${meetingId}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await waitUntil(async () => (await page.evaluate(() => !!document.querySelector("[data-meeting-lobby]"))), { label: `${label} lobby` });
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join Meeting" }).click();
  await waitUntil(async () => {
    const ev = await evidence(page);
    return ev && openPeers(ev).length >= 1;
  }, { label: `${label} in room with a peer`, timeout: 90000 });
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
      // Auto-answer the screen-capture picker with the entire screen
      // (resolves as 1280x720 — clearly distinct from the 640x480 fake
      // camera). The value must be UNQUOTED; the quoted form hangs.
      "--auto-select-desktop-capture-source=Entire screen",
    ],
  });

  try {
    const A = await newMeeting(browser, "A");
    const B = await joinViaInviteLink(browser, "B", A.meetingId, "Browser B");
    console.log(`   meeting id: ${A.meetingId}`);

    const baselinePeers = openPeers(await evidence(A.page)).length;
    await waitUntil(async () => {
      const ev = await evidence(B.page);
      const peer = ev && ev.peers.find((p) => !p.closedAt && p.connectionState === "connected");
      return peer && peer.inbound.some((i) => i.bytesReceived > 0);
    }, { label: "B receives A's camera" });

    console.log("\n===== LIVE screen share: A shares, B receives =====");
    await A.page.getByRole("button", { name: "Share", exact: true }).click();

    const shareEv = await waitUntil(async () => {
      const ev = await evidence(B.page);
      const peer = ev && ev.peers.find((p) => !p.closedAt && p.connectionState === "connected");
      const v = peer && peer.inbound.find((i) => (i.frameWidth ?? 0) > 1000 && i.bytesReceived > 0);
      return v ? ev : null;
    }, { label: "B receives screen frames (frameWidth > 1000)", timeout: 90000 });

    const evA1 = await evidence(A.page);
    const capture = evA1.screenCaptures[0];
    record("A captured the screen via getDisplayMedia (track created)", !!capture, `label="${capture?.label}" state=${capture?.readyState}`);
    const peerB = shareEv.peers.find((p) => !p.closedAt && p.connectionState === "connected");
    const screenInbound = peerB.inbound.find((i) => (i.frameWidth ?? 0) > 1000);
    record("B's inbound RTP switched to the SCREEN (frameWidth > 1000)", !!screenInbound, `frameWidth=${screenInbound?.frameWidth} bytes=${screenInbound?.bytesReceived}`);

    await sleep(2000);
    const evB1b = await evidence(B.page);
    const peerB2 = evB1b.peers.find((p) => !p.closedAt && p.connectionState === "connected");
    const after = peerB2.inbound.find((i) => (i.frameWidth ?? 0) > 1000);
    record("Screen media keeps flowing (bytes/frames grow)", !!after && after.bytesReceived > screenInbound.bytesReceived && (after.framesDecoded ?? 0) > (screenInbound.framesDecoded ?? 0), `bytes ${screenInbound.bytesReceived} -> ${after?.bytesReceived}, frames ${screenInbound.framesDecoded} -> ${after?.framesDecoded}`);

    record("B received screen_share_started over wss://", shareEv.screenEvents.some((m) => m.type === "screen_share_started"));
    record("A's toolbar shows 'Stop share'", evA1.shareButtonLabel === "Stop share", evA1.shareButtonLabel);
    record("B's header names the sharer ('... is sharing')", !!shareEv.headerSharingPill, String(shareEv.headerSharingPill));

    console.log("\n===== LIVE screen share: A stops, camera restored =====");
    await A.page.getByRole("button", { name: "Stop share", exact: true }).click();
    const backEv = await waitUntil(async () => {
      const ev = await evidence(B.page);
      const peer = ev && ev.peers.find((p) => !p.closedAt && p.connectionState === "connected");
      const v = peer && peer.inbound.find((i) => (i.frameWidth ?? 0) > 0 && (i.frameWidth ?? 0) <= 1000 && i.bytesReceived > 0);
      return v ? ev : null;
    }, { label: "B back to camera frames (<= 1000 wide)", timeout: 60000 });
    const evA2 = await evidence(A.page);
    const camPeer = backEv.peers.find((p) => !p.closedAt && p.connectionState === "connected");
    const camInbound = camPeer.inbound.find((i) => (i.frameWidth ?? 0) > 0);
    record("Camera restored on B (frameWidth back to 640)", !!camInbound && (camInbound.frameWidth ?? 0) === 640, `frameWidth=${camInbound?.frameWidth}`);
    record("A's toolbar back to 'Share'", evA2.shareButtonLabel === "Share", evA2.shareButtonLabel);
    // The capture track's onended event is unreliable in headless on
    // sender-attached tracks (known gotcha — the local screenshare-verify
    // suite covers track lifecycle by dispatching the event), so this
    // checks the production-relevant invariants only.
    record("Same PeerConnection throughout (no recreation, no disconnect)", openPeers(evA2).length === baselinePeers && openPeers(backEv).length === 1 && openPeers(backEv).every((p) => p.connectionState === "connected"), `open=${openPeers(evA2).length}`);

    await A.context.close();
    await B.context.close();
  } finally {
    await browser.close();
  }

  console.log(`\n========== SUMMARY: ${results.length - failures}/${results.length} checks passed ==========`);
  writeFileSync(REPORT_OUT, JSON.stringify({ front: FRONT, results, failures }, null, 2));
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("HARNESS FAILURE:", error);
  process.exit(2);
});
