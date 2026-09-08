"use client";

import { DoorOpen, ShieldAlert, UserX, VideoOff } from "lucide-react";

/**
 * Why this session ended. The server event (participant_removed /
 * meeting_ended / a voluntary leave) sets the reason explicitly — it is
 * never inferred from navigation or a missing connection, because a kick,
 * an end and a leave look identical on the wire once the socket closes.
 *
 * "denied" is the stale-identity case: someone re-opens a link with a
 * session that was removed earlier, and the server rejects the WebSocket.
 */
export type ExitReason = "left" | "kicked" | "ended" | "denied";

interface MeetingExitScreenProps {
  reason: ExitReason;
  meetingTitle?: string | null;
  /** True when the local user ended the meeting themselves (host copy). */
  isHost?: boolean;
  /** "link" = the user opened a link for a meeting that already ended, never having joined. */
  context?: "after-join" | "link";
  onHome: () => void;
  homeLabel?: string;
  /** Provided only where rejoining makes sense (voluntary leave / stale session). */
  onRejoin?: () => void;
}

const copy: Record<ExitReason, { icon: typeof DoorOpen; tone: string; title: (isHost: boolean, context: "after-join" | "link") => string; body: (context: "after-join" | "link") => string }> = {
  left: {
    icon: DoorOpen,
    tone: "text-slate-300 bg-white/10",
    title: () => "You left the meeting.",
    body: () => "You can rejoin while the meeting is still running.",
  },
  kicked: {
    icon: UserX,
    tone: "text-red-300 bg-red-500/15",
    title: () => "You were removed from the meeting.",
    body: () => "The host removed you from this meeting.",
  },
  ended: {
    icon: VideoOff,
    tone: "text-blue-200 bg-blue-500/15",
    // Someone who never joined reads a neutral "this meeting has ended";
    // only an in-meeting participant learns the host ended it, and the host
    // who did it gets the plain acknowledgement.
    title: (isHost, context) => (context === "link" ? "This meeting has ended." : isHost ? "Meeting ended." : "This meeting has been ended by the host."),
    body: (context) => (context === "link" ? "It is no longer possible to join this meeting." : "The meeting has ended for everyone."),
  },
  denied: {
    icon: ShieldAlert,
    tone: "text-amber-200 bg-amber-500/15",
    title: () => "You no longer have access to this meeting.",
    body: () => "Your previous session is no longer valid. Join again to continue.",
  },
};

/**
 * The single post-meeting screen. Every way out of a meeting lands here with
 * an explicit reason: voluntary leave, host removal, or the meeting ending.
 * Wording distinguishes the three so a removed participant is never told
 * they "left", and a host who ended the meeting is never told they were
 * removed.
 */
export default function MeetingExitScreen({ reason, meetingTitle, isHost = false, context = "after-join", onHome, homeLabel = "Back to Home", onRejoin }: MeetingExitScreenProps) {
  const config = copy[reason];
  const Icon = config.icon;
  return (
    <div data-exit-screen={reason} className="h-dvh w-full bg-[#0d1117] text-white flex items-center justify-center p-6">
      <div className="w-full max-w-sm text-center">
        <div className={`mx-auto w-14 h-14 rounded-2xl flex items-center justify-center ${config.tone}`} aria-hidden="true"><Icon className="w-6 h-6" /></div>
        <h2 className="mt-6 text-2xl font-semibold tracking-[-0.02em] text-balance">{config.title(isHost, context)}</h2>
        <p className="mt-3 text-sm text-slate-400">{config.body(context)}</p>
        {meetingTitle && <p className="mt-1.5 text-xs text-slate-500 truncate">{meetingTitle}</p>}
        <div className="mt-8 flex flex-col gap-2">
          <button onClick={onHome} className="w-full rounded-xl bg-[#2f6fed] px-4 py-3 text-sm font-semibold hover:bg-[#245dcc] transition-colors">{homeLabel}</button>
          {onRejoin && <button onClick={onRejoin} className="w-full rounded-xl bg-white/10 px-4 py-3 text-sm font-semibold text-slate-200 hover:bg-white/15 transition-colors">Join Again</button>}
        </div>
      </div>
    </div>
  );
}
