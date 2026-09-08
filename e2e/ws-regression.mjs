/**
 * Phase 1 WebSocket regression tests, run directly against the FastAPI
 * signaling server (no browser). Covers: handshake acceptance, room_state
 * broadcast, ping/pong, echo, malformed JSON, unknown message type, signaling
 * relay, room isolation, duplicate connection rejection (4008), and
 * disconnect cleanup.
 */
import WebSocket from "ws";

const API = "http://127.0.0.1:8000";
const WS_BASE = "ws://127.0.0.1:8000";

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const conn = { socket, messages: [], waiters: [] };
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { message = { type: "UNPARSEABLE", raw: raw.toString() }; }
      conn.messages.push(message);
      for (let i = conn.waiters.length - 1; i >= 0; i--) {
        const waiter = conn.waiters[i];
        if (waiter.predicate(message)) {
          conn.waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    });
    socket.on("open", () => resolve(conn));
    socket.on("error", reject);
  });
}

function waitFor(conn, predicate, timeoutMs = 8000, label = "message") {
  const existing = conn.messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    conn.waiters.push({ predicate, resolve: (m) => { clearTimeout(timer); resolve(m); }, timer });
  });
}

async function createMeeting() {
  const register = await fetch(`${API}/api/users/me`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), display_name: "WS Regression Host" }) });
  const user = await register.json();
  const meetingRes = await fetch(`${API}/api/meetings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "WS Regression", host_id: user.id }) });
  return (await meetingRes.json()).meeting_id;
}

async function createParticipant(meetingId, name) {
  const register = await fetch(`${API}/api/users/me`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), display_name: name }) });
  const user = await register.json();
  const res = await fetch(`${API}/api/meetings/${meetingId}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ display_name: name, user_id: user.id }) });
  return (await res.json()).id;
}

const wsUrl = (meetingId, participantId) =>
  `${WS_BASE}/api/ws/meetings/${encodeURIComponent(meetingId)}?participant_id=${encodeURIComponent(participantId)}`;

async function main() {
  const meetingId = await createMeeting();
  const pA = await createParticipant(meetingId, "WS A");
  const pB = await createParticipant(meetingId, "WS B");

  // 1-2. Handshake + room_state.
  const A = await connect(wsUrl(meetingId, pA));
  const roomState = await waitFor(A, (m) => m.type === "room_state", 8000, "room_state");
  record("First participant receives room_state", !!roomState, `participants=${roomState.participants?.length ?? "?"}`);

  // 3. Second participant joins: B's room_state lists A; A sees participant_joined.
  const B = await connect(wsUrl(meetingId, pB));
  const bRoomState = await waitFor(B, (m) => m.type === "room_state", 8000, "B room_state");
  const bSeesA = (bRoomState.participants || []).some((p) => p.participant_id === pA);
  record("B's room_state lists A", bSeesA);
  const joined = await waitFor(A, (m) => m.type === "participant_joined" && m.participant_id === pB, 8000, "participant_joined");
  record("A receives participant_joined for B", !!joined);

  // 4. ping -> pong.
  A.socket.send(JSON.stringify({ type: "ping" }));
  record("ping receives pong", !!(await waitFor(A, (m) => m.type === "pong", 8000, "pong").catch(() => null)));

  // 5. echo round-trip (backend echoes the "data" field back).
  A.socket.send(JSON.stringify({ type: "echo", data: { marker: "regression-42" } }));
  const echoed = await waitFor(A, (m) => m.type === "echo" && m.data?.marker === "regression-42", 8000, "echo").catch(() => null);
  record("echo returns payload", !!echoed);

  // 6. Malformed JSON -> INVALID_MESSAGE, connection survives.
  A.socket.send("this is not json {");
  const invalid = await waitFor(A, (m) => m.type === "error" && m.code === "INVALID_MESSAGE", 8000, "INVALID_MESSAGE").catch(() => null);
  record("Malformed JSON -> error INVALID_MESSAGE", !!invalid);

  // 7. Unknown message type -> error, connection survives.
  A.socket.send(JSON.stringify({ type: "definitely_not_a_type" }));
  const unknown = await waitFor(A, (m) => m.type === "error", 8000, "error for unknown type").catch(() => null);
  record("Unknown type -> error response", !!unknown && unknown.type === "error");
  A.socket.send(JSON.stringify({ type: "ping" }));
  record("Connection survives both error cases", !!(await waitFor(A, (m) => m.type === "pong", 8000, "pong after errors").catch(() => null)));

  // 8. Signaling relay: offer A->B arrives at B with sender_id=A.
  A.socket.send(JSON.stringify({ type: "offer", target_id: pB, payload: { type: "offer", sdp: "v=0 regression" } }));
  const relayed = await waitFor(B, (m) => m.type === "offer" && m.sender_id === pA, 8000, "relayed offer").catch(() => null);
  record("offer relayed to B with sender_id=A", !!relayed);

  // 9. Relay to absent participant -> TARGET_NOT_CONNECTED.
  A.socket.send(JSON.stringify({ type: "offer", target_id: "not-in-room", payload: { type: "offer", sdp: "x" } }));
  const notConnected = await waitFor(A, (m) => m.type === "error" && m.code === "TARGET_NOT_CONNECTED", 8000, "TARGET_NOT_CONNECTED").catch(() => null);
  record("Relay to absent target -> TARGET_NOT_CONNECTED", !!notConnected);

  // 10. Invalid meeting -> rejected with 1008.
  const badMeeting = await new Promise((resolve) => {
    const s = new WebSocket(wsUrl("no-such-meeting", pA));
    s.on("close", (code) => resolve(code));
    s.on("error", () => {});
  });
  record("Unknown meeting rejected with 1008", badMeeting === 1008, `code=${badMeeting}`);

  // 11. Room isolation: participant C in a different meeting gets nothing from room 1.
  const meeting2 = await createMeeting();
  const pC = await createParticipant(meeting2, "WS C (other room)");
  const C = await connect(wsUrl(meeting2, pC));
  await waitFor(C, (m) => m.type === "room_state", 8000, "C room_state");
  A.socket.send(JSON.stringify({ type: "offer", target_id: pB, payload: { type: "offer", sdp: "isolation-check" } }));
  await new Promise((r) => setTimeout(r, 800));
  const leaked = C.messages.filter((m) => m.sender_id === pA || JSON.stringify(m).includes("isolation-check"));
  record("No cross-room signaling leak", leaked.length === 0, `leaked=${leaked.length}`);
  const cRoomState = C.messages.find((m) => m.type === "room_state");
  const cOnly = (cRoomState?.participants || []).every((p) => p.participant_id === pC);
  record("C's room_state lists only C", cOnly);

  // 12. Duplicate connection: same participant id -> DUPLICATE_CONNECTION + 4008.
  let sawDuplicateError = false;
  const dupCode = await new Promise((resolve) => {
    const dup = new WebSocket(wsUrl(meetingId, pA));
    dup.on("message", (raw) => {
      try { const m = JSON.parse(raw.toString()); if (m.type === "error" && m.code === "DUPLICATE_CONNECTION") sawDuplicateError = true; } catch {}
    });
    dup.on("close", (code) => resolve(code));
    dup.on("error", () => {});
  });
  record("Duplicate connection gets DUPLICATE_CONNECTION error", sawDuplicateError);
  record("Duplicate connection closed with 4008", dupCode === 4008, `code=${dupCode}`);

  // 13. Original socket unaffected by the duplicate attempt.
  A.socket.send(JSON.stringify({ type: "ping" }));
  record("Original socket unaffected by duplicate attempt", !!(await waitFor(A, (m) => m.type === "pong", 8000, "pong after duplicate").catch(() => null)));

  // 14. Disconnect cleanup: B leaves -> A receives participant_left.
  B.socket.close(1000, "regression done");
  const left = await waitFor(A, (m) => m.type === "participant_left" && m.participant_id === pB, 8000, "participant_left").catch(() => null);
  record("participant_left broadcast on disconnect", !!left);

  A.socket.close(1000, "done");
  C.socket.close(1000, "done");

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} WebSocket regression checks passed`);
  for (const meeting of [meetingId, meeting2]) {
    await fetch(`${API}/api/meetings/${meeting}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "ended" }) }).catch(() => {});
  }
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => { console.error("REGRESSION CRASH:", error); process.exit(1); });
