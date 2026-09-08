/**
 * Phase 9 backend smoke probe, run directly against the FastAPI server (no
 * browser). Covers the three host-authorized events and reactions over the
 * existing single WebSocket: role checks (FORBIDDEN for guests), target
 * validation (INVALID_TARGET / CANNOT_REMOVE_SELF, cross-meeting scoping),
 * reaction validation + in-memory rate limit + broadcast shape, mute_all
 * broadcast shape and host exclusion, participant_removed broadcast, and
 * meeting_ended broadcast + status flip.
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

async function post(path, body) {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json();
}

// Registers the host user, creates the meeting, and joins it as host — the
// join response's role must be "host" for the smoke test to mean anything.
async function createHostMeeting(title) {
  const user = await post("/api/users/me", { id: crypto.randomUUID(), display_name: `${title} Host` });
  const meeting = await post("/api/meetings", { title, host_id: user.id });
  const host = await post(`/api/meetings/${meeting.meeting_id}/join`, { display_name: `${title} Host`, user_id: user.id });
  return { meetingId: meeting.meeting_id, hostId: host.id, hostRole: host.role };
}

async function createParticipant(meetingId, name) {
  const user = await post("/api/users/me", { id: crypto.randomUUID(), display_name: name });
  const res = await post(`/api/meetings/${meetingId}/join`, { display_name: name, user_id: user.id });
  return { id: res.id, role: res.role };
}

const wsUrl = (meetingId, participantId) =>
  `${WS_BASE}/api/ws/meetings/${encodeURIComponent(meetingId)}?participant_id=${encodeURIComponent(participantId)}`;

// Drain anything already in the buffer of a given type, then wait until no
// further such message arrives for a quiet period — used to prove an event
// that must NOT be broadcast never shows up.
function settle(conn, predicate, quietMs = 500) {
  return new Promise((resolve) => {
    let last = -1;
    const count = () => conn.messages.filter(predicate).length;
    const tick = () => {
      const now = count();
      if (now === last) { clearInterval(timer); resolve(now); }
      else { last = now; }
    };
    const timer = setInterval(tick, 100);
    setTimeout(() => { clearInterval(timer); resolve(count()); }, quietMs + 1200);
  });
}

async function main() {
  const room = await createHostMeeting("Phase 9 Smoke");
  record("Host joins with role=host", room.hostRole === "host");
  const guestA = await createParticipant(room.meetingId, "Guest A");
  const guestB = await createParticipant(room.meetingId, "Guest B");

  const H = await connect(wsUrl(room.meetingId, room.hostId));
  await waitFor(H, (m) => m.type === "room_state", 8000, "host room_state");
  const A = await connect(wsUrl(room.meetingId, guestA.id));
  await waitFor(A, (m) => m.type === "room_state", 8000, "A room_state");
  const B = await connect(wsUrl(room.meetingId, guestB.id));
  await waitFor(B, (m) => m.type === "room_state", 8000, "B room_state");
  await waitFor(H, (m) => m.type === "participant_joined" && m.participant_id === guestB.id, 8000, "host sees B join");

  // --- Reactions ---------------------------------------------------------
  H.socket.send(JSON.stringify({ type: "reaction", reaction: "👍" }));
  const reaction = await waitFor(B, (m) => m.type === "reaction", 8000, "reaction broadcast");
  record("Host reaction broadcasts to others", !!reaction);
  record("Reaction carries server-derived identity", reaction.participant_id === room.hostId && typeof reaction.participant_name === "string" && reaction.reaction === "👍" && !!reaction.timestamp, JSON.stringify({ id: reaction.participant_id?.slice(0, 8), name: reaction.participant_name }));

  A.socket.send(JSON.stringify({ type: "reaction", reaction: "🚀" }));
  const invalid = await waitFor(A, (m) => m.type === "error" && m.code === "INVALID_REACTION", 8000, "INVALID_REACTION");
  record("Arbitrary emoji rejected with INVALID_REACTION", !!invalid);
  const leaked = await settle(B, (m) => m.type === "reaction" && m.participant_id === guestA.id);
  record("Invalid reaction is never broadcast", leaked === 0, `B saw ${leaked}`);

  // Rate limit: 10 reactions fired as fast as the socket allows; only the
  // first 5 (limit per rolling second) may be broadcast.
  for (let i = 0; i < 10; i++) A.socket.send(JSON.stringify({ type: "reaction", reaction: "👏" }));
  const broadcastCount = await settle(B, (m) => m.type === "reaction" && m.participant_id === guestA.id, 900);
  record("Rate limit caps a burst at 5 per second", broadcastCount === 5, `B received ${broadcastCount}`);

  // --- Guest cannot use host events --------------------------------------
  A.socket.send(JSON.stringify({ type: "mute_all" }));
  const forbiddenMute = await waitFor(A, (m) => m.type === "error" && m.code === "FORBIDDEN", 8000, "mute_all FORBIDDEN");
  record("Guest mute_all rejected with FORBIDDEN", !!forbiddenMute && forbiddenMute.message === "Only the host can perform this action.");
  const noMuteLeak = await settle(B, (m) => m.type === "mute_all");
  record("Rejected mute_all is not broadcast", noMuteLeak === 0);

  A.socket.send(JSON.stringify({ type: "remove_participant", target_participant_id: room.hostId }));
  const forbiddenRemove = await waitFor(A, (m) => m.type === "error" && m.code === "FORBIDDEN", 8000, "remove FORBIDDEN");
  record("Guest remove_participant rejected with FORBIDDEN", !!forbiddenRemove);

  A.socket.send(JSON.stringify({ type: "meeting_ended" }));
  const forbiddenEnd = await waitFor(A, (m) => m.type === "error" && m.code === "FORBIDDEN", 8000, "end FORBIDDEN");
  record("Guest meeting_ended rejected with FORBIDDEN", !!forbiddenEnd);

  // --- Host mute_all ------------------------------------------------------
  H.socket.send(JSON.stringify({ type: "mute_all" }));
  const muteAll = await waitFor(B, (m) => m.type === "mute_all", 8000, "mute_all broadcast");
  record("Host mute_all reaches guests with initiator id", !!muteAll && muteAll.initiated_by === room.hostId);
  const hostSawOwn = await settle(H, (m) => m.type === "mute_all");
  record("Host is excluded from its own mute_all", hostSawOwn === 0);

  // --- remove_participant validation --------------------------------------
  H.socket.send(JSON.stringify({ type: "remove_participant", target_participant_id: room.hostId }));
  const selfRemove = await waitFor(H, (m) => m.type === "error" && m.code === "CANNOT_REMOVE_SELF", 8000, "CANNOT_REMOVE_SELF");
  record("Host cannot remove themselves", !!selfRemove && selfRemove.message.includes("End the meeting"));

  H.socket.send(JSON.stringify({ type: "remove_participant", target_participant_id: "00000000-0000-0000-0000-000000000000" }));
  const ghostRemove = await waitFor(H, (m) => m.type === "error" && m.code === "INVALID_TARGET", 8000, "INVALID_TARGET");
  record("Unknown target rejected with INVALID_TARGET", !!ghostRemove);

  // Cross-meeting: a host in meeting A cannot remove a participant of meeting B.
  const other = await createHostMeeting("Other Meeting");
  const otherGuest = await createParticipant(other.meetingId, "Other Guest");
  const O = await connect(wsUrl(other.meetingId, other.hostId));
  await waitFor(O, (m) => m.type === "room_state", 8000, "other host room_state");
  H.socket.send(JSON.stringify({ type: "remove_participant", target_participant_id: otherGuest.id }));
  const crossRemove = await waitFor(H, (m) => m.type === "error" && m.code === "INVALID_TARGET", 8000, "cross-meeting INVALID_TARGET");
  record("Host cannot remove a participant from another meeting", !!crossRemove);
  const otherStillListed = await fetch(`${API}/api/meetings/${other.meetingId}/participants`).then((r) => r.json());
  record("Other meeting's participant untouched", otherStillListed.some((p) => p.id === otherGuest.id && !p.left_at));
  O.socket.close();

  // --- Real removal -------------------------------------------------------
  H.socket.send(JSON.stringify({ type: "remove_participant", target_participant_id: guestB.id }));
  const removedAtA = await waitFor(A, (m) => m.type === "participant_removed" && m.participant_id === guestB.id, 8000, "participant_removed at A");
  const removedAtB = await waitFor(B, (m) => m.type === "participant_removed" && m.participant_id === guestB.id, 8000, "participant_removed at B (target)");
  record("participant_removed broadcast to everyone including the target", !!removedAtA && !!removedAtB);

  // --- meeting_ended ------------------------------------------------------
  H.socket.send(JSON.stringify({ type: "meeting_ended" }));
  const endedA = await waitFor(A, (m) => m.type === "meeting_ended", 8000, "meeting_ended at A");
  const endedH = await waitFor(H, (m) => m.type === "meeting_ended", 8000, "meeting_ended at host");
  record("meeting_ended broadcast to everyone including the host", !!endedA && !!endedH);
  const detail = await fetch(`${API}/api/meetings/${room.meetingId}`).then((r) => r.json());
  record("Meeting status flips to ended", detail.status === "ended");

  for (const conn of [H, A, B]) conn.socket.close();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
