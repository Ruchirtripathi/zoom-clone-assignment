"use client";

import { ArrowLeft, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocalMedia } from "../hooks/useLocalMedia";
import LocalVideoTile from "./LocalVideoTile";
import { formatScheduleTime, parseBackendDate } from "../lib/invite";
import type { MeetingSummary } from "../lib/types";

interface MeetingLobbyProps {
  meeting: MeetingSummary;
  /** Prefilled from the browser's stored identity; the guest may change it per session. */
  defaultName: string;
  /** The single media instance shared with the room — no second getUserMedia. */
  localMedia: ReturnType<typeof useLocalMedia>;
  onJoin: (name: string) => void;
  onCancel: () => void;
  joining: boolean;
  joinError: string | null;
}

const NAME_MAX_LENGTH = 80;

/**
 * The single join surface: direct invite links, the Meetings page and the
 * dashboard Join dialog all land here. Media preview, name entry and device
 * toggles happen BEFORE the participant is created — opening a link never
 * creates a participant record until the user actually joins.
 */
export default function MeetingLobby({ meeting, defaultName, localMedia, onJoin, onCancel, joining, joinError }: MeetingLobbyProps) {
  const [name, setName] = useState(defaultName);
  const [nameError, setNameError] = useState<string | null>(null);
  const { stream, streamRef, isAudioEnabled, isVideoEnabled, toggleAudio, toggleVideo, startMedia, error: mediaError } = localMedia;

  // The preview reuses the controller's media instance: if a stream already
  // exists (e.g. returning to the lobby via Join Again) it is shown as-is,
  // never re-requested. When there is no stream and no permanent error yet,
  // start once — an invalid link never reaches the lobby, so asking here is
  // safe (and idempotent on StrictMode's double mount). Note the lobby
  // deliberately does NOT stop media on unmount: joining swaps this lobby
  // for the room and the room inherits the very same stream. Cancelling is
  // the controller's job — it stops media before navigating away.
  useEffect(() => {
    if (!stream && !mediaError) void startMedia();
  }, [stream, mediaError, startMedia]);

  const submitJoin = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Please enter your name");
      return;
    }
    setNameError(null);
    onJoin(trimmed);
  };

  const scheduledNotice = meeting.scheduled_at && parseBackendDate(meeting.scheduled_at).getTime() > Date.now()
    ? `This meeting is scheduled for ${formatScheduleTime(meeting.scheduled_at)}. You can join early — others will see you arrive.`
    : null;

  return (
    <div data-meeting-lobby className="h-dvh w-full bg-[#0d1117] text-white flex flex-col md:flex-row">
      <div className="relative flex-1 min-h-[240px] md:min-h-0 bg-[#171d27] md:border-r border-b md:border-b-0 border-white/10 flex items-center justify-center overflow-hidden">
        <div className="relative w-full max-w-2xl aspect-video mx-4 my-auto">
          <LocalVideoTile stream={stream} streamRef={streamRef} name={name || "You"} videoEnabled={isVideoEnabled} />
          {!stream && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6">
              <div className="w-14 h-14 rounded-2xl bg-white/5 text-slate-400 flex items-center justify-center"><VideoOff className="w-6 h-6" /></div>
              <p className="text-sm text-slate-400">{mediaError ? mediaError.message : "Starting camera preview…"}</p>
              {mediaError && <button onClick={() => startMedia()} className="text-sm font-semibold text-blue-300 hover:text-blue-200 underline underline-offset-4">Try again</button>}
            </div>
          )}
          <div className="absolute bottom-3 left-3 text-xs bg-black/60 rounded-md px-2 py-1">{isVideoEnabled ? "Camera preview" : "Camera is off"}</div>
        </div>
      </div>

      <div className="w-full md:w-[400px] shrink-0 flex flex-col justify-center p-6 sm:p-8 md:px-10 overflow-y-auto">
        <div className="md:hidden w-9 h-9 mb-4 rounded-lg bg-[#2f6fed] flex items-center justify-center font-semibold text-sm shrink-0">M</div>
        <h1 className="text-xl md:text-2xl font-semibold tracking-[-0.02em] text-balance">{meeting.title}</h1>
        <p className="mt-2 text-xs text-slate-400">Meeting ID: {meeting.meeting_id}</p>

        {scheduledNotice && <div className="mt-4 rounded-xl border border-blue-400/20 bg-blue-500/10 px-4 py-3 text-xs text-blue-200">{scheduledNotice}</div>}

        <form onSubmit={submitJoin} className="mt-6 flex flex-col gap-4" noValidate>
          <label className="block">
            <span className="block text-xs font-semibold text-slate-300 mb-2">Your name</span>
            <input
              value={name}
              onChange={(event) => { setName(event.target.value); if (nameError) setNameError(null); }}
              maxLength={NAME_MAX_LENGTH}
              placeholder="Enter your name"
              aria-label="Your name"
              aria-invalid={!!nameError}
              className={`w-full rounded-xl bg-white/10 border px-4 py-3 text-sm outline-none focus:border-blue-400 placeholder:text-slate-500 ${nameError ? "border-red-400/60" : "border-white/10"}`}
            />
            {nameError && <span role="alert" className="block mt-2 text-xs text-red-300">{nameError}</span>}
          </label>

          {mediaError && <div role="status" className="rounded-xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-xs text-amber-100">{mediaError.message} You can still join the meeting.</div>}
          {joinError && <div role="alert" className="rounded-xl border border-red-300/20 bg-red-400/10 px-4 py-3 text-xs text-red-100">{joinError}</div>}

          <div className="flex items-center gap-3">
            <button type="button" onClick={toggleAudio} className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${isAudioEnabled ? "bg-white/10 text-white hover:bg-white/20" : "bg-red-500/90 text-white"}`} aria-label={isAudioEnabled ? "Mute microphone" : "Unmute microphone"} aria-pressed={!isAudioEnabled}>{isAudioEnabled ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}</button>
            <button type="button" onClick={toggleVideo} className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${isVideoEnabled ? "bg-white/10 text-white hover:bg-white/20" : "bg-red-500/90 text-white"}`} aria-label={isVideoEnabled ? "Turn camera off" : "Turn camera on"} aria-pressed={!isVideoEnabled}>{isVideoEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}</button>
            <span className="text-xs text-slate-500">Microphone and camera can also be changed inside the meeting.</span>
          </div>

          <button type="submit" disabled={joining} className="w-full rounded-xl bg-[#2f6fed] px-4 py-3 text-sm font-semibold hover:bg-[#245dcc] transition-colors disabled:opacity-60">
            {joining ? "Joining…" : "Join Meeting"}
          </button>
          <button type="button" onClick={onCancel} className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-400 hover:text-white transition-colors flex items-center justify-center gap-1.5"><ArrowLeft className="w-4 h-4" /> Back</button>
        </form>
      </div>
    </div>
  );
}
