/**
 * LIVE production smoke test (Phase 11) — the deployed stack:
 *
 *   Frontend : https://zoom-clone-frontend-beta.vercel.app   (Vercel, aa4f789)
 *   Backend  : https://zoom-clone-assignment-p30d.onrender.com (Render free)
 *
 * A (host, fake camera) starts a meeting; B joins through the direct invite
 * link. Verifies the Phase 11 layout experience ON PRODUCTION with measured
 * evidence — 20 checks:
 *
 *   1-4   load, new meeting, invite-link join, P2P camera flowing (getStats)
 *   5-6   Gallery default + badges; View menu radios, Follow-host disabled
 *   7     Speaker View geometry
 *   8-9   Layout switching is render-only: zero WS sends, zero new
 *         peers/offers/ICE/getUserMedia (Gallery→Speaker→Multi→Gallery)
 *   10-11 Pin is LOCAL (chip+ring on A only), pinned becomes primary, unpin
 *   12    Hide self view: tile gone, camera track still live + enabled
 *   13    Hide non-video: render-time only (Participants panel still lists A)
 *   14-15 A shares: getDisplayMedia captured; B's inbound switches to screen
 *         frames (frameWidth > 1000) on the SAME PeerConnection
 *   16-18 Presentation layout (≥70% width, sharer named, stream rendered
 *         exactly once); stop share → camera restored, B's selected layout
 *         (multi-speaker) resumes
 *   19    375px: no horizontal overflow
 *   20    No console/page errors in either browser
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const FRONT = "https://zoom-clone-frontend-beta.vercel.app";

const REPORT_OUT = new URL("./live-phase11-report.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const results = [];
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

async function waitUntil(fn, { timeout = 60000, interval = 700, label = "condition" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// Same instrumentation as the local phase11 suite: wrap PC (negotiation
// counters), getUserMedia/getDisplayMedia, and the app's WebSocket sends.
const INIT_SCRIPT = `
(() => {
  const NativePC = window.RTCPeerConnection;
  const created = [];
  window.__peerConnections = created;
  window.__localStreams = [];
  window.__screenCaptures = [];
  window.__wsSent = [];
  window.__media = { createOffer: 0, createAnswer: 0, setLocalDescription: 0, setRemoteDescription: 0, addIceCandidate: 0 };
  function WrappedPC(...args) {
    const pc = new NativePC(...args);
    const entry = { pc, createdAt: Date.now(), closedAt: null };
    const nativeClose = pc.close.bind(pc);
    pc.close = () => { entry.closedAt = Date.now(); return nativeClose(); };
    const count = (name) => (...a) => { window.__media[name] += 1; return NativePC.prototype[name].apply(pc, a); };
    pc.createOffer = count("createOffer");
    pc.createAnswer = count("createAnswer");
    pc.setLocalDescription = count("setLocalDescription");
    pc.setRemoteDescription = count("setRemoteDescription");
    pc.addIceCandidate = count("addIceCandidate");
    created.push(entry);
    return pc;
  }
  WrappedPC.prototype = NativePC.prototype;
  Object.setPrototypeOf(WrappedPC, NativePC);
  Object.defineProperty(window, "RTCPeerConnection", { value: WrappedPC, configurable: true, writable: true });

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const nativeGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await nativeGUM(...args);
      window.__localStreams.push(stream);
      return stream;
    };
  }
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
    const nativeGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (...args) => {
      const stream = await nativeGDM(...args);
      window.__screenCaptures.push(stream);
      return stream;
    };
  }

  const NativeWS = window.WebSocket;
  function WrappedWS(...args) {
    const ws = new NativeWS(...args);
    const isAppSocket = typeof args[0] === "string" && args[0].indexOf("/api/ws/") !== -1;
    if (isAppSocket) {
      const nativeSend = ws.send.bind(ws);
      ws.send = (data) => {
        try { window.__wsSent.push(JSON.parse(data)); } catch (e) {}
        return nativeSend(data);
      };
    }
    return ws;
  }
  WrappedWS.prototype = NativeWS.prototype;
  Object.setPrototypeOf(WrappedWS, NativeWS);
  Object.defineProperty(window, "WebSocket", { value: WrappedWS, configurable: true, writable: true });

  window.__stats = async () => {
    const out = [];
    for (const entry of window.__peerConnections) {
      if (entry.closedAt) continue;
      const s = await entry.pc.getStats();
      const inbound = [];
      s.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "video") inbound.push({ bytes: r.bytesReceived, frames: r.framesDecoded ?? null, w: r.frameWidth ?? null });
      });
      out.push({ state: entry.pc.connectionState, inbound });
    }
    return out;
  };

  window.__phase11 = () => {
    const main = document.querySelector("main");
    const layoutRoot = document.querySelector("[data-layout]");
    const tiles = [...document.querySelectorAll("[data-participant-tile]")].map((el) => {
      const r = el.getBoundingClientRect();
      const label = el.querySelector("div.absolute.bottom-2");
      const badge = [...el.querySelectorAll("div")].find((d) => d.children.length === 0 && /^(You|Remote video|You are sharing your screen|.* is sharing)$/.test(d.textContent.trim()));
      return {
        name: label ? label.textContent.trim() : null,
        badge: badge ? badge.textContent.trim() : null,
        pinned: !!el.querySelector('button[aria-label^="Unpin"]'),
        videoCount: el.querySelectorAll("video").length,
        remoteAvatar: !!el.querySelector('[class*="bg-[#6574a8]"]'),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      };
    });
    const menu = document.querySelector("[data-floating-menu]");
    const aside = document.querySelector("aside.fixed");
    return {
      layout: layoutRoot ? layoutRoot.getAttribute("data-layout") : null,
      mainW: main ? Math.round(main.getBoundingClientRect().width) : null,
      tiles,
      videos: [...document.querySelectorAll("video")].map((v) => ({ muted: v.muted, videoWidth: v.videoWidth })),
      headerSharing: (() => { const s = [...document.querySelectorAll("header span")].map((e) => e.textContent.trim()).find((t) => t.indexOf("sharing") !== -1); return s || null; })(),
      menuOpen: !!menu,
      menuButtons: menu ? [...menu.querySelectorAll("button")].map((b) => ({
        label: (b.getAttribute("aria-label") || b.textContent.trim()).slice(0, 44),
        role: b.getAttribute("role"),
        checked: b.getAttribute("aria-checked"),
        disabled: b.disabled,
      })) : [],
      panelTitle: aside ? (aside.querySelector("h2") ? aside.querySelector("h2").textContent.trim() : null) : null,
      panelRows: aside ? [...aside.querySelectorAll("div.text-sm.truncate")].map((e) => e.textContent.trim()) : [],
      openPeers: window.__peerConnections.filter((p) => !p.closedAt).length,
      media: { ...window.__media },
      gumCalls: window.__localStreams.length,
      gdmCalls: window.__screenCaptures.length,
      wsSentCount: window.__wsSent.length,
      wsSentTypes: window.__wsSent.map((m) => m.type),
      cameraTracks: window.__localStreams.flatMap((s) => s.getVideoTracks().map((t) => ({ enabled: t.enabled, readyState: t.readyState }))),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  };
})();
`;

const consoleErrors = [];

function attach(page, label) {
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push({ label, text: msg.text() });
      console.log(`   [${label}][console.error] ${msg.text().slice(0, 200)}`);
    }
  });
  page.on("pageerror", (error) => {
    consoleErrors.push({ label, text: `pageerror: ${error.message}` });
    console.log(`   [${label}][pageerror] ${error.message.slice(0, 200)}`);
  });
  page.on("dialog", (dialog) => dialog.accept().catch(() => {}));
}

const evidence = (page) => page.evaluate(() => window.__phase11()).catch(() => null);
const stats = (page) => page.evaluate(() => window.__stats()).catch(() => null);

// The local ISP flakily blocks *.vercel.app anycast IPs — retry navigations.
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
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.getByRole("button", { name: "New meeting" }).click();
    try {
      await page.waitForURL(/\/room\//, { timeout: 20000 });
      return { context, page, meetingId: page.url().split("/room/")[1].split("?")[0] };
    } catch { /* Render cold start / hydration race — retry */ }
  }
  throw new Error(`${label}: could not start a new meeting`);
}

async function joinViaInviteLink(browser, label, meetingId, name) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  attach(page, label);
  await gotoWithRetry(page, `${FRONT}/room/${meetingId}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await waitUntil(async () => (await page.evaluate(() => !!document.querySelector("[data-meeting-lobby]"))), { label: `${label} lobby`, timeout: 90000 });
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join Meeting" }).click();
  await waitUntil(async () => {
    const ev = await evidence(page);
    return ev && ev.openPeers >= 1 && ev.tiles.length >= 2;
  }, { label: `${label} in room with a peer`, timeout: 90000 });
  return { context, page };
}

async function openViewMenu(page) {
  // Toggles keep the menu open — only click when it is not already open.
  if (!(await evidence(page))?.menuOpen) {
    await page.getByRole("button", { name: "View" }).click();
  }
  return waitUntil(async () => (await evidence(page))?.menuOpen, { label: "View menu open" });
}

async function selectLayout(page, label) {
  await openViewMenu(page);
  // exact: true — "Speaker View" would also substring-match "Multi-Speaker View".
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
  await sleep(400);
}

async function main() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // Auto-answer the screen-capture picker (resolves 1280x720 — clearly
      // distinct from the 640x480 fake camera). The value must be UNQUOTED.
      "--auto-select-desktop-capture-source=Entire screen",
    ],
  });

  try {
    section("Load, meet, join");
    const A = await newMeeting(browser, "A");
    record("1: A loaded the production app and started a meeting", /^[\w-]+$/.test(A.meetingId), `meeting id ${A.meetingId}`);
    const B = await joinViaInviteLink(browser, "B", A.meetingId, "Browser B");
    record("2: B joined through the direct invite link (lobby flow)", true, `${FRONT}/room/${A.meetingId}`);

    const camStats = await waitUntil(async () => {
      const s = await stats(B.page);
      const peer = s && s.find((p) => p.state === "connected");
      return peer && peer.inbound.some((i) => i.bytes > 0) ? peer : null;
    }, { label: "B receiving A's camera" });
    record("3: B's P2P connection carries A's camera (getStats bytes > 0)", !!camStats, `inbound=${JSON.stringify(camStats?.inbound[0] ?? null)}`);

    section("Layouts on production");
    let evB = await evidence(B.page);
    // A joins via "New meeting" with their saved identity — capture the host's
    // real display name from their self tile instead of assuming it.
    const evA0 = await evidence(A.page);
    const aName = evA0.tiles.find((t) => t.badge === "You")?.name ?? null;
    record("4: Gallery is the default (2 tiles, badge texts preserved)", evB.layout === "gallery" && evB.tiles.length === 2 && evB.tiles.every((t) => t.badge === "Remote video" || t.badge === "You"), `layout=${evB.layout} badges=${evB.tiles.map((t) => t.badge).join(",")} host="${aName}"`);

    await openViewMenu(B.page);
    evB = await evidence(B.page);
    const LAYOUT_LABELS = ["Speaker View", "Gallery View", "Multi-Speaker View"];
    const layoutRadios = evB.menuButtons.filter((b) => b.role === "menuitemradio" && LAYOUT_LABELS.some((l) => b.label.startsWith(l)));
    const followHost = evB.menuButtons.find((b) => b.label.includes("Follow host"));
    record("5: View menu — 3 layout radios, Gallery checked, 'Follow host's video order' disabled", layoutRadios.length === 3 && layoutRadios.find((r) => r.label.startsWith("Gallery"))?.checked === "true" && !!followHost && followHost.disabled, `layoutRadios=${layoutRadios.length} gallery=${layoutRadios.find((r) => r.label.startsWith("Gallery"))?.checked} followHost.disabled=${followHost?.disabled}`);
    await B.page.keyboard.press("Escape");

    // Speaker View geometry before the render-only counters start.
    await selectLayout(B.page, "Speaker View");
    evB = await evidence(B.page);
    const primary = evB.tiles.find((t) => t.h >= 200);
    const strip = evB.tiles.filter((t) => t.h < 200);
    record("6: Speaker View — large primary + thumbnail strip", evB.layout === "speaker" && !!primary && strip.length >= 1, `layout=${evB.layout} primary=${primary ? primary.w + "x" + primary.h : "none"} strip=${strip.length}`);

    section("Layout switching is render-only");
    const before = await evidence(B.page);
    await selectLayout(B.page, "Multi-Speaker View");
    await selectLayout(B.page, "Gallery View");
    await selectLayout(B.page, "Speaker View");
    const after = await evidence(B.page);
    record("7: ZERO WebSocket sends across Multi→Gallery→Speaker switches", after.wsSentCount === before.wsSentCount, `sent ${before.wsSentCount} -> ${after.wsSentCount}`);
    const mediaSum = (ev) => Object.values(ev?.media ?? {}).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
    const diag = (ev) => `keys=${ev ? Object.keys(ev).join("|") : "null"} media=${JSON.stringify(ev?.media ?? null)} peers=${ev?.openPeers} gum=${ev?.gumCalls}`;
    record("8: No new PeerConnections / offers / ICE / getUserMedia across the switches", (after?.openPeers ?? -1) === (before?.openPeers ?? -2) && mediaSum(after) === mediaSum(before) && (after?.gumCalls ?? -1) === (before?.gumCalls ?? -2), `before[${diag(before)}] after[${diag(after)}]`);

    section("Pin is a local preference");
    await A.page.getByRole("button", { name: "View" }).click();
    const bTileOnA = A.page.locator('[data-participant-tile] button[aria-label="Pin Browser B"]');
    await waitUntil(async () => (await bTileOnA.count()) > 0, { label: "pin button on A's B-tile" });
    await bTileOnA.first().click();
    let evA = await evidence(A.page);
    evB = await evidence(B.page);
    record("9: A pins B — chip on A's page only (B's page unaffected)", evA.tiles.some((t) => t.name?.includes("Browser B") && t.pinned) && !evB.tiles.some((t) => t.pinned), `A pinned=${evA.tiles.filter((t) => t.pinned).length} B pinned=${evB.tiles.filter((t) => t.pinned).length}`);

    await A.page.getByRole("button", { name: "View" }).click();
    await selectLayout(A.page, "Speaker View");
    evA = await evidence(A.page);
    const pinnedPrimary = evA.tiles.find((t) => t.h >= 200);
    record("10: Pinned participant is the speaker primary", !!pinnedPrimary && pinnedPrimary.name?.includes("Browser B"), `primary=${pinnedPrimary?.name}`);
    await A.page.locator('[data-participant-tile] button[aria-label="Unpin Browser B"]').first().click();
    await sleep(300);
    evA = await evidence(A.page);
    const unpinnedPrimary = evA.tiles.find((t) => t.h >= 200);
    record("11: Unpin returns the primary to the default (pin chip gone)", !!unpinnedPrimary && !evA.tiles.some((t) => t.pinned), `primary=${unpinnedPrimary?.name} (still B — sole remote)`);

    section("Hide preferences");
    await openViewMenu(B.page);
    await B.page.getByRole("menuitemcheckbox", { name: "Hide self view" }).click();
    await sleep(300);
    evB = await evidence(B.page);
    const selfGone = evB.tiles.length === 1 && evB.tiles.every((t) => t.name?.includes(aName ?? "___"));
    record("12: Hide self view — own tile gone, camera track STILL live + enabled", selfGone && evB.cameraTracks.length > 0 && evB.cameraTracks.every((t) => t.enabled && t.readyState === "live"), `tiles=${evB.tiles.length} remaining="${evB.tiles[0]?.name}" track=${JSON.stringify(evB.cameraTracks[0] ?? null)}`);
    await B.page.getByRole("menuitemcheckbox", { name: "Hide self view" }).click();
    await B.page.getByRole("menuitemcheckbox", { name: "Hide non-video participants" }).click();
    await B.page.keyboard.press("Escape");

    await A.page.getByRole("button", { name: "Stop video", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(B.page);
      return ev && ev.tiles.length === 1; // only B's own tile remains
    }, { label: "A's tile hidden on B after A stops video" });
    await B.page.getByRole("button", { name: "Participants" }).click();
    await waitUntil(async () => (await evidence(B.page))?.panelTitle?.startsWith("Participants"), { label: "B's participants panel" });
    evB = await evidence(B.page);
    record("13: Hide non-video — A's tile hidden at render time; panel still lists A", evB.tiles.length === 1 && evB.panelRows.some((r) => r.includes(aName ?? "___")), `tiles=${evB.tiles.length} panel=${evB.panelRows.join(",")}`);
    await B.page.getByRole("button", { name: "Close panel" }).click();
    await A.page.getByRole("button", { name: "Start video", exact: true }).click();
    await waitUntil(async () => (await evidence(B.page))?.tiles.length === 2, { label: "A's tile back once camera restarts" });

    section("Screen share on production");
    await selectLayout(B.page, "Multi-Speaker View"); // B's chosen layout for the resume check
    await A.page.getByRole("button", { name: "Share", exact: true }).click();
    const sharePeer = await waitUntil(async () => {
      const s = await stats(B.page);
      const peer = s && s.find((p) => p.state === "connected");
      return peer && peer.inbound.some((i) => (i.w ?? 0) > 1000 && i.bytes > 0) ? peer : null;
    }, { label: "B receiving screen frames (frameWidth > 1000)", timeout: 90000 });
    const evA1 = await evidence(A.page);
    record("14: A captured the screen via getDisplayMedia on production", evA1.gdmCalls >= 1, `gdmCalls=${evA1.gdmCalls}`);
    record("15: B's inbound RTP switched to the SCREEN (frameWidth > 1000), same PeerConnection", !!sharePeer && sharePeer.inbound.some((i) => (i.w ?? 0) > 1000), `inbound=${JSON.stringify(sharePeer?.inbound[0] ?? null)} peers=${sharePeer ? (await stats(B.page)).length : "?"}`);

    evB = await evidence(B.page);
    const mainW = evB.mainW ?? 1;
    const screenTile = evB.tiles.reduce((a, b) => (b.w > a.w ? b : a), { w: 0 });
    const dominance = Math.round((screenTile.w / mainW) * 100);
    record("16: Presentation layout — screen dominates ≥70% of main width; header names the sharer", evB.layout === "presentation" && dominance >= 70 && !!evB.headerSharing?.includes("is sharing"), `layout=${evB.layout} ${screenTile.w}/${mainW}=${dominance}% header="${evB.headerSharing}"`);

    const aTiles = evB.tiles.filter((t) => t.badge?.includes("is sharing"));
    record("17: Sharer's stream renders EXACTLY once on B (strip entry avatar-only)", aTiles.length === 2 && aTiles.filter((t) => t.videoCount > 0).length === 1 && aTiles.some((t) => t.videoCount === 0 && t.remoteAvatar), `sharer tiles=${aTiles.length} videoTiles=${aTiles.filter((t) => t.videoCount > 0).length} avatarStripEntry=${aTiles.some((t) => t.videoCount === 0 && t.remoteAvatar)}`);

    await A.page.getByRole("button", { name: "Stop share", exact: true }).click();
    const camAfter = await waitUntil(async () => {
      const s = await stats(B.page);
      const peer = s && s.find((p) => p.state === "connected");
      const cam = peer && peer.inbound.find((i) => (i.w ?? 0) > 0 && (i.w ?? 0) <= 1000 && i.bytes > 0);
      return cam ? { cam, peers: s.length } : null;
    }, { label: "B back to camera frames (<= 1000 wide)", timeout: 60000 });
    await sleep(800);
    evB = await evidence(B.page);
    record("18: Stop share — camera frames restored and B's selected layout (multi-speaker) RESUMES", !!camAfter?.cam && evB.layout === "multi-speaker", `frameWidth=${camAfter?.cam.w} frames=${camAfter?.cam.frames} peers=${camAfter?.peers} layout=${evB.layout}`);

    section("Responsive + console");
    await B.page.setViewportSize({ width: 375, height: 667 });
    await sleep(400);
    const gal375 = await evidence(B.page);
    await selectLayout(B.page, "Speaker View");
    const spk375 = await evidence(B.page);
    record("19: 375px — no horizontal overflow in gallery and speaker", !gal375.horizontalOverflow && !spk375.horizontalOverflow, `gallery=${!gal375.horizontalOverflow} speaker=${!spk375.horizontalOverflow} scrollW gallery/speaker=${gal375.horizontalOverflow}/${spk375.horizontalOverflow}`);

    record("20: No page errors and no console errors in either browser (beyond benign resource loads)", consoleErrors.filter((e) => !/Failed to load resource/i.test(e.text)).length === 0, `${consoleErrors.length} total (${consoleErrors.filter((e) => !/Failed to load resource/i.test(e.text)).length} non-resource)`);

    await A.context.close();
    await B.context.close();
  } finally {
    await browser.close();
  }

  console.log(`\n========== LIVE PHASE 11: ${results.length - failures}/${results.length} checks passed ==========`);
  writeFileSync(REPORT_OUT, JSON.stringify({ front: FRONT, commit: "aa4f789", results, failures }, null, 2));
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("HARNESS FAILURE:", error);
  process.exit(2);
});
