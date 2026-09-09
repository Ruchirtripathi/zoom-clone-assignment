/**
 * Phase 11 — Meeting video layout experience (runtime verification).
 *
 * Drives real Edge sessions (A host, B and C joiners) through the actual UI
 * and verifies, with measured DOM/media evidence:
 *
 *   S1  Gallery is the default; equal-sized tiles; badge texts preserved
 *   S2  View menu: radios + aria-checked, disabled "Follow host's video
 *       order", toggles, Escape close, outside-click close
 *   S3  Speaker View: large remote primary + horizontal thumbnail strip
 *   S4  Multi-Speaker View: primary + vertical sidebar (dominant primary)
 *   S5  Layout switching is render-only: ZERO new PeerConnections,
 *       offers/answers/descriptions/ICE, getUserMedia/getDisplayMedia, and
 *       ZERO WebSocket sends across Gallery→Speaker→Multi→Gallery
 *   S6  Pin/Unpin: chip+ring, LOCAL only (B's page unaffected), pinned
 *       becomes speaker primary, unpin falls back to first remote
 *   S7  Hide Self View: own tile gone, camera track still live+enabled
 *   S8  Hide Non-video: camera-off participant hidden at render time only
 *       (Participants panel still lists them), reappears when camera on
 *   S9  Sort gallery by name
 *   S10 Presentation: screen dominant (~79%), sharer's stream in exactly
 *       ONE video (avatar-only strip entry), pin respected but screen stays
 *       primary during share, pinned becomes primary after stop, viewer's
 *       selected layout resumes
 *   S11 Sharer with camera OFF is never hidden by "hide non-video"
 *   S12 Sharer leaves mid-share → presentation cleared; pinned participant
 *       leaves → pin auto-cleared, no blank primary
 *   S13 Responsive 375px (gallery/speaker/presentation, no horizontal
 *       overflow) and 1440px (presentation dominance)
 *
 * The five earlier suites are the regression net for everything not
 * re-checked here.
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const FRONT = "http://localhost:3000";
const REPORT_OUT = new URL("./phase11-report.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const LOGS_OUT = new URL("./phase11-console.log", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

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

// Injected before any page script. Counts every WebRTC/media/WS action so
// the layout-switch test can prove layout changes never touch them.
const INIT_SCRIPT = `
(() => {
  const NativePC = window.RTCPeerConnection;
  const created = [];
  window.__peerConnections = created;
  window.__localStreams = [];
  window.__screenCaptures = [];
  window.__wsSent = [];
  window.__negotiationCalls = [];
  window.__media = { createOffer: 0, createAnswer: 0, setLocalDescription: 0, setRemoteDescription: 0, addIceCandidate: 0 };
  function WrappedPC(...args) {
    const pc = new NativePC(...args);
    const entry = { pc, createdAt: Date.now(), closedAt: null };
    const nativeClose = pc.close.bind(pc);
    pc.close = () => { entry.closedAt = Date.now(); return nativeClose(); };
    const count = (name) => (...a) => { window.__media[name] += 1; return nativeProto[name].apply(pc, a); };
    const nativeProto = NativePC.prototype;
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
    // Only the app's signaling socket is recorded — Next dev's HMR socket
    // (/_next/webpack-hmr) also sends periodic pings that would pollute the
    // "no sends while switching layouts" evidence.
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

  window.__phase11 = () => {
    const main = document.querySelector("main");
    const layoutRoot = document.querySelector("[data-layout]");
    const header = document.querySelector("header");
    const headerText = header ? header.textContent : "";
    const tiles = [...document.querySelectorAll("[data-participant-tile]")].map((el) => {
      const r = el.getBoundingClientRect();
      const label = el.querySelector("div.absolute.bottom-2");
      const badge = [...el.querySelectorAll("div")].find((d) => d.children.length === 0 && /^(You|Remote video|You are sharing your screen|.* is sharing)$/.test(d.textContent.trim()));
      return {
        name: label ? label.textContent.trim() : null,
        badge: badge ? badge.textContent.trim() : null,
        pinned: !!el.querySelector('button[aria-label^="Unpin"]'),
        hasPinButton: !!el.querySelector('button[aria-label^="Pin "]') || !!el.querySelector('button[aria-label^="Unpin"]'),
        videoCount: el.querySelectorAll("video").length,
        remoteAvatar: !!el.querySelector('[class*="bg-[#6574a8]"]'),
        localAvatar: !!el.querySelector('[class*="bg-[#b96e3d]"]'),
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

const evidence = (page) => page.evaluate(() => window.__phase11()).catch(() => null);

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
      return { context, page, meetingId: page.url().split("/room/")[1].split("?")[0] };
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

async function openViewMenu(page) {
  // Toggles keep the menu open (several preferences can be set at once), so
  // only click the toolbar button when the menu is not already open — a
  // blind click would toggle it closed.
  if (!(await evidence(page))?.menuOpen) {
    await page.getByRole("button", { name: "View" }).click();
  }
  return waitUntil(async () => (await evidence(page))?.menuOpen, { label: "View menu open" });
}

async function selectLayout(page, label) {
  await openViewMenu(page);
  // exact: true — Playwright's default name match is substring-based, and
  // "Speaker View" would also match "Multi-Speaker View".
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
  await sleep(300);
}

const namesOf = (ev) => ev.tiles.map((t) => t.name);

async function main() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // Auto-answer the screen-capture picker (unquoted — the quoted form hangs).
      "--auto-select-desktop-capture-source=Entire screen",
      "--host-resolver-rules=MAP localhost:8000 127.0.0.1",
    ],
  });

  try {
    section("S1 — Defaults: Gallery, equal tiles, badge contract");
    const A = await newMeeting(browser, "A");
    const B = await joinMeeting(browser, "B", A.meetingId, "Browser B");
    const C = await joinMeeting(browser, "C", A.meetingId, "Browser C");
    console.log(`   meeting id: ${A.meetingId}`);
    await Promise.all([A, B, C].map((x) => waitUntil(async () => {
      const ev = await evidence(x.page);
      return ev && ev.tiles.length === 3;
    }, { label: `${x.page === A.page ? "A" : x.page === B.page ? "B" : "C"} sees 3 tiles` })));

    let evA = await evidence(A.page);
    record("T1: default layout is Gallery (no menu ever opened)", evA.layout === "gallery", `layout=${evA.layout}`);
    record("T1: gallery shows all 3 tiles with preserved badge texts",
      evA.tiles.length === 3 && evA.tiles.some((t) => t.badge === "You") && evA.tiles.filter((t) => t.badge === "Remote video").length === 2,
      `badges=${evA.tiles.map((t) => t.badge).join(" | ")}`);
    const widths = evA.tiles.map((t) => t.w);
    const heights = evA.tiles.map((t) => t.h);
    record("T1: gallery tiles are equal-sized (responsive grid)",
      Math.max(...widths) - Math.min(...widths) <= 3 && Math.max(...heights) - Math.min(...heights) <= 3,
      `w=[${widths.join(",")}] h=[${heights.join(",")}]`);
    record("T1: every tile exposes a pin button (Pin {name}/Unpin {name})",
      evA.tiles.every((t) => t.hasPinButton), `tiles=${evA.tiles.length}`);

    section("S2 — View menu: radios, disabled item, Escape + outside-click");
    await openViewMenu(A.page);
    evA = await evidence(A.page);
    const radios = evA.menuButtons.filter((b) => b.role === "menuitemradio");
    const toggles = evA.menuButtons.filter((b) => b.role === "menuitemcheckbox");
    const followHost = evA.menuButtons.find((b) => b.label.startsWith("Follow host's video order"));
    record("T2: menu lists the 3 layouts as radios, Gallery checked, others not, sort=Join order",
      radios.length === 5 &&
      radios.find((b) => b.label === "Gallery View")?.checked === "true" &&
      radios.find((b) => b.label === "Speaker View")?.checked === "false" &&
      radios.find((b) => b.label === "Multi-Speaker View")?.checked === "false" &&
      radios.find((b) => b.label === "Join order")?.checked === "true",
      `radios=${radios.map((b) => `${b.label}[${b.checked}]`).join(", ")}`);
    record("T2: 'Follow host's video order' is shown DISABLED (coming soon, not faked)",
      !!followHost && followHost.disabled === true && followHost.label.includes("Coming soon"),
      followHost ? `${followHost.label} disabled=${followHost.disabled}` : "missing");
    record("T2: Hide self view + Hide non-video participants are checkbox toggles (off by default)",
      toggles.length === 2 && toggles.every((b) => b.checked === "false"),
      `toggles=${toggles.map((b) => b.label).join(",")}`);
    await A.page.keyboard.press("Escape");
    record("T2: Escape closes the View menu", (await evidence(A.page)).menuOpen === false);
    await openViewMenu(A.page);
    await A.page.getByRole("button", { name: "Participants" }).click({ position: { x: 5, y: 5 } }).catch(() => {});
    await A.page.mouse.click(30, 100);
    record("T2: click outside closes the View menu", (await evidence(A.page)).menuOpen === false);
    await A.page.getByRole("button", { name: "Close panel" }).click();

    section("S3 — Speaker View: remote primary + horizontal strip");
    await selectLayout(A.page, "Speaker View");
    evA = await evidence(A.page);
    const primary = evA.tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    const strip = evA.tiles.filter((t) => t !== primary);
    record("T3: speaker layout active with one dominant primary (remote, not self)",
      evA.layout === "speaker" && primary.badge === "Remote video" && primary.h > strip[0].h * 1.5,
      `primary=${primary.name} ${primary.w}x${primary.h}, thumbs=${strip.map((t) => t.h).join(",")}`);
    record("T3: strip is horizontal (thumbs share a row, primary above)",
      strip.length === 2 && Math.abs(strip[0].y - strip[1].y) <= 3 && strip[0].y > primary.y,
      `y=[${strip.map((t) => t.y).join(",")}] primaryY=${primary.y}`);

    section("S4 — Multi-Speaker View: primary + vertical sidebar");
    await selectLayout(A.page, "Multi-Speaker View");
    evA = await evidence(A.page);
    const pms = evA.tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    const sidebar = evA.tiles.filter((t) => t !== pms);
    record("T4: multi-speaker layout active, sidebar is VERTICAL on desktop",
      evA.layout === "multi-speaker" && sidebar.length === 2 && Math.abs(sidebar[0].x - sidebar[1].x) <= 3 && sidebar[0].x > pms.x,
      `x=[${sidebar.map((t) => t.x).join(",")}] primaryX=${pms.x}`);
    record("T4: primary dominates the stage (>= 65% of main width)", pms.w / evA.mainW >= 0.65, `${pms.w}/${evA.mainW}=${(pms.w / evA.mainW).toFixed(2)}`);

    section("S5 — Layout switching never touches WebRTC / media / WebSocket");
    const before = await evidence(A.page);
    await selectLayout(A.page, "Gallery View");
    await selectLayout(A.page, "Speaker View");
    await selectLayout(A.page, "Multi-Speaker View");
    await selectLayout(A.page, "Gallery View");
    const after = await evidence(A.page);
    const mediaKeys = Object.keys(after.media);
    const wsDelta = after.wsSentTypes.slice(before.wsSentCount);
    record("T5: ZERO new PeerConnections / offers / answers / descriptions / ICE across 4 switches",
      after.openPeers === before.openPeers && mediaKeys.every((k) => after.media[k] === before.media[k]),
      `peers ${before.openPeers}->${after.openPeers}, offer ${before.media.createOffer}->${after.media.createOffer}, ice ${before.media.addIceCandidate}->${after.media.addIceCandidate}`);
    record("T5: ZERO getUserMedia/getDisplayMedia calls and ZERO WebSocket sends while switching",
      after.gumCalls === before.gumCalls && after.gdmCalls === before.gdmCalls && after.wsSentCount === before.wsSentCount,
      `gum ${before.gumCalls}->${after.gumCalls}, gdm ${before.gdmCalls}->${after.gdmCalls}, wsSent ${before.wsSentCount}->${after.wsSentCount}, delta=[${wsDelta.join(",")}]`);

    section("S6 — Pin / Unpin (local viewer preference, never broadcast)");
    // Speaker view so the pinned participant becomes an observable primary.
    await selectLayout(A.page, "Speaker View");
    const pinC = A.page.locator('button[aria-label="Pin Browser C"]').first();
    await pinC.hover(); // exercises the hover-reveal affordance, then click
    await pinC.click();
    await sleep(400);
    evA = await evidence(A.page);
    const evB = await evidence(B.page);
    const cTile = evA.tiles.find((t) => t.name === "Browser C");
    record("T6: pinned tile shows the Pinned state (chip + unpin control)",
      cTile && cTile.pinned === true, `pinned=${cTile?.pinned}, tiles=${evA.tiles.map((t) => `${t.name}:${t.pinned}`).join(",")}`);
    const sentTypes = (evA.wsSentTypes || []).filter((t) => (t || "").includes("pin"));
    record("T6: pin is LOCAL — B's page shows no pinned tile and no pin message was ever sent",
      evB.tiles.every((t) => !t.pinned) && sentTypes.length === 0,
      `B pinnedTiles=${evB.tiles.filter((t) => t.pinned).length}, pinMessages=${sentTypes.length}`);
    const primS6 = evA.tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    record("T6: pinned participant becomes the speaker primary", primS6.name === "Browser C", `primary=${primS6.name}`);
    await A.page.locator('button[aria-label="Unpin Browser C"]').first().click();
    await sleep(400);
    evA = await evidence(A.page);
    const primS6b = evA.tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    record("T6: unpin returns to the deterministic default (first remote)",
      primS6b.name === "Browser B" && evA.tiles.every((t) => !t.pinned), `primary=${primS6b.name}`);

    section("S7 — Hide Self View (rendering only; camera keeps running)");
    await openViewMenu(A.page);
    await A.page.getByRole("menuitemcheckbox", { name: "Hide self view" }).click();
    await sleep(400);
    evA = await evidence(A.page);
    record("T7: self tile disappears; camera track stays live and enabled",
      evA.tiles.length === 2 && !evA.tiles.some((t) => t.badge === "You") &&
        evA.cameraTracks.length > 0 && evA.cameraTracks.every((t) => t.enabled && t.readyState === "live"),
      `tiles=${evA.tiles.length}, camera=${JSON.stringify(evA.cameraTracks[0] ?? null)}`);
    await openViewMenu(A.page);
    await A.page.getByRole("menuitemcheckbox", { name: "Hide self view" }).click();
    await sleep(400);
    record("T7: disabling the toggle restores the self tile", (await evidence(A.page)).tiles.length === 3);

    section("S8 — Hide Non-video Participants (filter-only, roster untouched)");
    await B.page.getByRole("button", { name: "Stop video", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev.tiles.find((t) => t.name === "Browser B")?.remoteAvatar === true;
    }, { label: "A sees B's camera-off avatar" });
    await openViewMenu(A.page);
    await A.page.getByRole("menuitemcheckbox", { name: "Hide non-video participants" }).click();
    await sleep(400);
    evA = await evidence(A.page);
    record("T8: camera-off participant hidden from the video area",
      evA.tiles.length === 2 && !evA.tiles.some((t) => t.name === "Browser B"),
      `tiles=${namesOf(evA).join(",")}`);
    await A.page.getByRole("button", { name: "Participants" }).click();
    await sleep(300);
    evA = await evidence(A.page);
    record("T8: Participants panel still lists the hidden participant (roster NOT mutated)",
      evA.panelTitle === "Participants (3)" && evA.panelRows.some((r) => r.includes("Browser B")),
      `${evA.panelTitle} rows=${evA.panelRows.join(" | ")}`);
    await A.page.getByRole("button", { name: "Close panel" }).click();
    await B.page.getByRole("button", { name: "Start video" }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev.tiles.length === 3 && ev.tiles.some((t) => t.name === "Browser B");
    }, { label: "B reappears when the camera comes back on" });
    record("T8: participant reappears the moment their camera turns on", true);

    section("S9 — Sort gallery by name");
    await selectLayout(A.page, "Gallery View");
    await openViewMenu(A.page);
    await A.page.getByRole("menuitemradio", { name: "Name (A-Z)", exact: true }).click();
    await sleep(400);
    evA = await evidence(A.page);
    const sorted = [...namesOf(evA)].sort((a, b) => a.localeCompare(b));
    record("T9: gallery reorders to alphabetical (A-Z) sort",
      JSON.stringify(namesOf(evA)) === JSON.stringify(sorted), `order=[${namesOf(evA).join(", ")}]`);
    await openViewMenu(A.page);
    await A.page.getByRole("menuitemradio", { name: "Join order", exact: true }).click();
    await sleep(400);

    section("S10 — Presentation: dominant screen, one video per stream, pin during share");
    // A stays in Speaker view: after the share stops, the selected layout must
    // resume AND the pinned participant must become the primary.
    await selectLayout(A.page, "Speaker View");
    await B.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev.layout === "presentation" && ev.headerSharing === "Browser B is sharing" && ev.videos.some((v) => !v.muted && v.videoWidth > 1000);
    }, { timeout: 60000, label: "A in presentation with B's screen frames" });
    evA = await evidence(A.page);
    const primS10 = evA.tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    const bStrip = evA.tiles.filter((t) => t.name === "Browser B" && t !== primS10);
    record("T10: presentation layout active; header names the sharer; screen is the primary",
      evA.layout === "presentation" && primS10.badge === "Browser B is sharing",
      `primaryBadge=${primS10.badge}`);
    record("T10: the screen dominates the stage (>= 65% of main width)",
      primS10.w / evA.mainW >= 0.65, `${primS10.w}/${evA.mainW}=${(primS10.w / evA.mainW).toFixed(2)}`);
    record("T10: sharer's strip entry is avatar-only; their stream renders in exactly ONE video",
      bStrip.length === 1 && bStrip[0].videoCount === 0 && evA.videos.filter((v) => !v.muted && v.videoWidth > 1000).length === 1,
      `stripEntryVideos=${bStrip[0]?.videoCount}, screenVideos=${evA.videos.filter((v) => !v.muted && v.videoWidth > 1000).length}`);
    // Pin C during the share: screen must stay primary, C emphasized in strip.
    await A.page.locator('button[aria-label="Pin Browser C"]').first().click();
    await sleep(400);
    evA = await evidence(A.page);
    const primS10b = evA.tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    const cStrip = evA.tiles.find((t) => t.name === "Browser C");
    record("T10: pinning during a share does NOT displace the screen (C pinned in strip)",
      primS10b.badge === "Browser B is sharing" && cStrip && cStrip.pinned === true && cStrip !== primS10b,
      `primary=${primS10b.badge}, C pinned=${cStrip?.pinned}`);
    await B.page.getByRole("button", { name: "Stop share", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      if (ev.layout !== "speaker") return null;
      const prim = ev.tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
      return prim.name === "Browser C" ? ev : null;
    }, { label: "share stopped → speaker layout resumes with pinned C primary" });
    evA = await evidence(A.page);
    record("T10: after the share stops the VIEWER's selected layout resumes and the PINNED participant is primary",
      evA.layout === "speaker" && evA.tiles.some((t) => t.pinned), `layout=${evA.layout}`);
    await A.page.locator('button[aria-label="Unpin Browser C"]').first().click();
    await sleep(300);

    section("S11 — Sharer with camera OFF is exempt from hide-non-video");
    await B.page.getByRole("button", { name: "Stop video", exact: true }).click();
    await sleep(800);
    await openViewMenu(A.page);
    // The toggle is currently OFF (turned off in S8 aftermath? verify by state):
    const evToggle = await evidence(A.page);
    if (evToggle.menuButtons.find((b) => b.label === "Hide non-video participants")?.checked !== "true") {
      await A.page.getByRole("menuitemcheckbox", { name: "Hide non-video participants" }).click();
    } else {
      await A.page.keyboard.press("Escape");
    }
    await sleep(400);
    evA = await evidence(A.page);
    record("T11: setup — camera-off B is hidden by hide-non-video",
      !evA.tiles.some((t) => t.name === "Browser B"), `tiles=${namesOf(evA).join(",")}`);
    await B.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev.layout === "presentation" && ev.videos.some((v) => !v.muted && v.videoWidth > 1000);
    }, { timeout: 60000, label: "camera-off B starts sharing" });
    evA = await evidence(A.page);
    record("T11: the camera-OFF sharer is NOT hidden (screen_share exception) — they are the presentation",
      evA.tiles.some((t) => t.badge === "Browser B is sharing"), `badges=${evA.tiles.map((t) => t.badge).join(" | ")}`);
    await B.page.getByRole("button", { name: "Stop share", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev.layout === "speaker" && !ev.tiles.some((t) => t.name === "Browser B");
    }, { label: "share stopped → B hidden again (camera still off)" });
    record("T11: after the share stops (camera still off) B is hidden again",
      !(await evidence(A.page)).tiles.some((t) => t.name === "Browser B"));
    await openViewMenu(A.page);
    await A.page.getByRole("menuitemcheckbox", { name: "Hide non-video participants" }).click();
    await B.page.getByRole("button", { name: "Start video" }).click();
    await sleep(600);

    section("S12 — Sharer leaves mid-share; pinned participant leaves (invalidation)");
    await B.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev.layout === "presentation";
    }, { timeout: 60000, label: "B shares again" });
    await A.page.locator('button[aria-label="Pin Browser C"]').first().click();
    await sleep(300);
    await B.page.getByRole("button", { name: "End", exact: true }).click();
    await B.page.waitForURL(FRONT + "/", { timeout: 30000 }).catch(() => {});
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev.layout === "speaker" && ev.tiles.length === 2;
    }, { label: "sharer left → presentation cleared, back to speaker" });
    evA = await evidence(A.page);
    record("T12: sharer leaving mid-share clears the presentation (selected layout resumes)",
      evA.layout === "speaker" && !evA.headerSharing, `layout=${evA.layout}, header=${evA.headerSharing}`);
    await C.page.getByRole("button", { name: "End", exact: true }).click();
    await C.page.waitForURL(FRONT + "/", { timeout: 30000 }).catch(() => {});
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev.tiles.length === 1;
    }, { label: "C left → only A remains" });
    evA = await evidence(A.page);
    const primS12 = evA.tiles[0];
    record("T12: pinned participant leaving auto-clears the pin — no blank primary (self fallback)",
      evA.tiles.length === 1 && evA.tiles.every((t) => !t.pinned) && primS12 && primS12.badge === "You" && primS12.w > 0,
      `tiles=${evA.tiles.length}, pinned=${evA.tiles.filter((t) => t.pinned).length}, primary=${primS12?.badge}`);

    section("S13 — Responsive: 375px mobile and 1440px desktop");
    await selectLayout(A.page, "Gallery View");
    await A.page.setViewportSize({ width: 375, height: 667 });
    await sleep(500);
    let evM = await evidence(A.page);
    const galleryOk = !evM.horizontalOverflow && evM.tiles.length === 1;
    await selectLayout(A.page, "Speaker View");
    await sleep(400);
    evM = await evidence(A.page);
    const speakerOk = !evM.horizontalOverflow;
    record("T13: 375px — no horizontal overflow in gallery and speaker",
      galleryOk && speakerOk, `gallery=${galleryOk}, speaker=${speakerOk}`);
    // Presentation at 375: C already left, so B is gone — rejoin a sharer.
    const D = await joinMeeting(browser, "D", A.meetingId, "Browser D");
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev.tiles.length === 2;
    }, { label: "D joined" });
    await D.page.getByRole("button", { name: "Share", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev.layout === "presentation" && ev.videos.some((v) => !v.muted && v.videoWidth > 1000);
    }, { timeout: 60000, label: "D shares at 375px" });
    evM = await evidence(A.page);
    const primM = evM.tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    const stripM = evM.tiles.filter((t) => t !== primM);
    record("T13: 375px — presentation: screen on top, strip below, no horizontal overflow",
      !evM.horizontalOverflow && evM.tiles.length === 3 && stripM.every((t) => t.y > primM.y),
      `overflow=${evM.horizontalOverflow}, tiles=${evM.tiles.length}, primaryY=${primM.y}, stripY=${stripM.map((t) => t.y).join(",")}`);
    await A.page.setViewportSize({ width: 1440, height: 900 });
    await sleep(500);
    const evXL = await evidence(A.page);
    const primXL = evXL.tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    record("T13: 1440px — presentation screen dominates (>= 70% of main width), no overflow",
      !evXL.horizontalOverflow && primXL.w / evXL.mainW >= 0.7,
      `${primXL.w}/${evXL.mainW}=${(primXL.w / evXL.mainW).toFixed(2)}, overflow=${evXL.horizontalOverflow}`);
    await D.page.getByRole("button", { name: "Stop share", exact: true }).click();
    await waitUntil(async () => {
      const ev = await evidence(A.page);
      return ev.layout === "speaker";
    }, { label: "D stopped sharing" });

    section("Console audit");
    const errors = logs.filter((l) => l.type === "error" || l.type === "pageerror");
    record("T14: no console errors or page errors on any browser", errors.length === 0,
      errors.slice(0, 5).map((l) => `${l.label}: ${l.text.slice(0, 80)}`).join(" ;; "));

    await A.context.close();
    await D.context.close();
    B.context.close().catch(() => {});
    C.context.close().catch(() => {});
  } finally {
    await browser.close();
  }

  console.log(`\n========== SUMMARY: ${results.length - failures}/${results.length} checks passed ==========`);
  writeFileSync(REPORT_OUT, JSON.stringify({ results, failures }, null, 2));
  writeFileSync(LOGS_OUT, logs.map((l) => `[${l.label}][${l.type}] ${l.text}`).join("\n"));
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("HARNESS FAILURE:", error);
  process.exit(2);
});
