"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useLocalMedia } from "../../../hooks/useLocalMedia";
import MeetingLobby from "../../../components/MeetingLobby";
import MeetingRoom from "../../../components/MeetingRoom";
import MeetingExitScreen, { type ExitReason } from "../../../components/MeetingExitScreen";
import MeetingNotFound from "../../../components/MeetingNotFound";
import { apiUrl, ensureIdentity, readStoredIdentity } from "../../../lib/identity";
import type { MeetingSummary } from "../../../lib/types";

/**
 * Room controller. A single /room/{meeting_id} route resolves every entry
 * path — direct invite link, Meetings page Start, dashboard Join — into one
 * of five views: loading, not found, the join lobby, the live room, or an
 * exit screen with an explicit reason.
 *
 * It owns the ONE useLocalMedia instance for the join: the lobby previews
 * with it and the room inherits it, so a join is a single getUserMedia.
 * Media is only requested once the meeting is known to be real — an invalid
 * or ended link never touches the camera.
 */

type Lookup = "loading" | "ready" | "not-found" | "ended" | "unreachable";

type Session = { participantId: string; name: string };

type Exit = { reason: ExitReason; isHost: boolean };

function LookupScreen({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="h-dvh w-full bg-[#0d1117] text-white flex items-center justify-center p-6">
      <div className="text-center">
        {onRetry ? (
          <>
            <h2 className="text-xl font-semibold">Unable to reach the meeting service</h2>
            <p className="mt-2 text-sm text-slate-400">Check your connection and try again.</p>
            <button onClick={onRetry} className="mt-5 rounded-xl bg-[#2f6fed] px-4 py-3 text-sm font-semibold hover:bg-[#245dcc]">Try Again</button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 rounded-full border-2 border-white/20 border-t-white/70 animate-spin" aria-hidden="true" />
            <p className="text-sm text-slate-400">{message}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function RoomPage() {
  const { meeting_id } = useParams<{ meeting_id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const meetingId = String(meeting_id || "");

  // Fast path: an existing session in the URL (dashboard auto-join, an e2e
  // join, or a refresh mid-meeting) skips the lobby. A bare link — every
  // invite that is ever shared — goes through the lobby instead.
  const [session, setSession] = useState<Session | null>(() => {
    const participantId = searchParams.get("participant_id");
    if (!participantId) return null;
    return { participantId, name: searchParams.get("name") || "Guest" };
  });
  const [meeting, setMeeting] = useState<MeetingSummary | null>(null);
  const [lookup, setLookup] = useState<Lookup>("loading");
  const [exit, setExit] = useState<Exit | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  // The lobby's name field prefills from the browser identity (default user)
  // but is editable per session — a guest joins as whoever they type.
  const [defaultName] = useState(() => (typeof window === "undefined" ? "" : readStoredIdentity().displayName));

  const audioPreference = searchParams.get("audio") !== "false";
  const videoPreference = searchParams.get("video") !== "false";
  const localMedia = useLocalMedia({ audioEnabled: audioPreference, videoEnabled: videoPreference, autoStart: false });

  // Resolve the meeting ID once per link. 404 is a product state ("meeting
  // not found"), a network failure is a retryable one — the two never share
  // a screen, and neither ever surfaces a raw error.
  const lookupMeeting = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/meetings/${meetingId}`);
      if (response.status === 404) { setLookup("not-found"); return; }
      if (!response.ok) { setLookup("unreachable"); return; }
      const details = await response.json() as MeetingSummary;
      setMeeting(details);
      // Ended meetings never join: no lobby, no camera, no WebSocket.
      setLookup(details.status === "ended" ? "ended" : "ready");
    } catch {
      setLookup("unreachable");
    }
  };

  useEffect(() => {
    setLookup("loading");
    void lookupMeeting();
  }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fast path only: the lobby starts its own preview, but a URL session
  // mounts the room directly, so the controller starts media for it. Never
  // runs for not-found/ended links, and is a no-op once a stream exists.
  useEffect(() => {
    if (lookup !== "ready" || exit || !session) return;
    if (!localMedia.stream && !localMedia.error) void localMedia.startMedia();
  }, [lookup, exit, session, localMedia.stream, localMedia.error, localMedia.startMedia]);

  const endFromLink = () => {
    localMedia.stopMedia();
    setExit({ reason: "ended", isHost: false });
  };

  const handleJoin = async (displayName: string) => {
    setJoining(true);
    setJoinError(null);
    try {
      // Identity first, then the participant record — a participant is
      // created only at the moment of joining, never by opening a link.
      const user = await ensureIdentity();
      const response = await fetch(`${apiUrl}/api/meetings/${meetingId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName, user_id: user.id }),
      });
      if (response.status === 404) { setLookup("not-found"); return; }
      if (response.status === 410) { endFromLink(); return; }
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        setJoinError(detail?.detail || "Unable to join this meeting. Please try again.");
        return;
      }
      const participant = await response.json();
      setSession({ participantId: participant.id, name: displayName });
      // Session established — now swap the lobby for the room. A query-only
      // replace keeps this component (and its media stream) mounted: the
      // room inherits the lobby's exact stream, no second getUserMedia. The
      // URL also carries the current toggle state so a refresh restores it.
      const params = new URLSearchParams({
        participant_id: participant.id,
        name: displayName,
        audio: String(localMedia.isAudioEnabled),
        video: String(localMedia.isVideoEnabled),
      });
      router.replace(`/room/${meetingId}?${params.toString()}`);
    } catch {
      setJoinError("Unable to reach the meeting service. Please try again.");
    } finally {
      setJoining(false);
    }
  };

  const cancelLobby = () => {
    localMedia.stopMedia();
    router.push("/");
  };

  // The room has already closed its peers and stopped media before calling
  // this; stopping again is an idempotent net for exits that bypass the room.
  const handleExit = (reason: ExitReason, details?: { isHost?: boolean }) => {
    localMedia.stopMedia();
    setExit({ reason, isHost: details?.isHost ?? false });
    // Strip the session from the URL so a refresh after leaving starts a
    // fresh join flow rather than resurrecting a dead participant id.
    router.replace(`/room/${meetingId}`);
  };

  const handleRejoin = () => {
    setExit(null);
    setSession(null);
  };

  const retryLookup = () => {
    setLookup("loading");
    setMeeting(null);
    void lookupMeeting();
  };

  if (exit) {
    const fromLink = !session;
    return (
      <MeetingExitScreen
        reason={exit.reason}
        meetingTitle={meeting?.title ?? null}
        isHost={exit.isHost}
        context={fromLink ? "link" : "after-join"}
        homeLabel={exit.reason === "ended" && fromLink ? "Back to Meetings" : "Back to Home"}
        onHome={() => router.push(exit.reason === "ended" && fromLink ? "/meetings" : "/")}
        onRejoin={exit.reason === "left" || exit.reason === "denied" ? handleRejoin : undefined}
      />
    );
  }

  if (lookup === "not-found") {
    return <MeetingNotFound onHome={() => router.push("/")} onMeetings={() => router.push("/meetings")} />;
  }

  if (lookup === "ended") {
    return <MeetingExitScreen reason="ended" meetingTitle={meeting?.title ?? null} context="link" homeLabel="Back to Meetings" onHome={() => router.push("/meetings")} />;
  }

  if (lookup === "unreachable") {
    return <LookupScreen message="" onRetry={retryLookup} />;
  }

  if (lookup === "loading" || !meeting) {
    return <LookupScreen message="Finding meeting…" />;
  }

  if (session) {
    return (
      <MeetingRoom
        meeting={meeting}
        participantId={session.participantId}
        name={session.name}
        localMedia={localMedia}
        onExit={handleExit}
      />
    );
  }

  return (
    <MeetingLobby
      meeting={meeting}
      defaultName={defaultName}
      localMedia={localMedia}
      onJoin={handleJoin}
      onCancel={cancelLobby}
      joining={joining}
      joinError={joinError}
    />
  );
}
