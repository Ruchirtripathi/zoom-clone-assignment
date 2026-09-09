"use client";

import { Check, Crown, MicOff, Pin } from "lucide-react";
import type { MutableRefObject, ReactNode } from "react";
import LocalVideoTile from "./LocalVideoTile";
import RemoteVideoTile from "./RemoteVideoTile";

// The viewer's camera-layout preference. Presentation (screen share) is not
// a member of this union: it is a transient state that overrides whichever
// layout is selected, and that layout resumes the moment sharing stops.
export type MeetingLayout = "speaker" | "gallery" | "multi-speaker";
export type GallerySort = "join" | "name";

// A participant flattened for rendering: the roster row, with the local
// browser's own media state overlaid — our own audio/video events are
// broadcast to others, never echoed back to us, so self reads the live
// local-media state instead of the roster copy.
export type TileParticipant = {
  participant_id: string;
  name: string;
  role: string;
  audio_enabled: boolean;
  video_enabled: boolean;
  is_screen_sharing: boolean;
  is_self: boolean;
};

// Everything a tile needs to render one participant's media. Each tile
// picks exactly ONE video slot from this context — local camera, local
// screen, remote stream, or avatar — so every participant's stream renders
// in at most one <video> element on the page.
export type TileContext = {
  localStream: MediaStream | null;
  localStreamRef: MutableRefObject<MediaStream | null>;
  /** Non-null only while WE are sharing — useWebRTC's single source of truth. */
  localScreenStream: MediaStream | null;
  /** Remote streams keyed by participant_id (the shared MediaStream carries the sharer's screen via replaceTrack). */
  remoteStreams: Record<string, MediaStream>;
  /** LOCAL viewer preference — never broadcast; null when nothing is pinned. */
  pinnedParticipantId: string | null;
  onTogglePin: (participantId: string) => void;
};

interface ParticipantTileProps {
  tile: TileParticipant;
  ctx: TileContext;
  /** Sizing/positioning comes from the parent layout (w-*, aspect-video, h-full...). */
  className?: string;
  /** Thumbnail chrome (strip entries): smaller badges and labels. */
  thumb?: boolean;
  /** True only for the sharer's tile as the presentation primary. */
  screenPrimary?: boolean;
}

export function ParticipantTile({ tile, ctx, className = "", thumb = false, screenPrimary = false }: ParticipantTileProps) {
  const selfSharing = tile.is_self && tile.is_screen_sharing;
  const remoteSharing = !tile.is_self && tile.is_screen_sharing;

  // Exactly one video slot per participant. The sharer's stream renders
  // once — as the presentation primary (screenPrimary) — while their strip
  // entry is an avatar with NO video element: a second <video> bound to the
  // same stream would double-decode it and break the suite-level invariant
  // of one video element per stream.
  let videoSlot: ReactNode;
  if (selfSharing) {
    videoSlot = screenPrimary
      ? <LocalVideoTile stream={ctx.localStream} streamRef={ctx.localStreamRef} displayStream={ctx.localScreenStream} name={tile.name} videoEnabled isSharing />
      : <LocalVideoTile stream={null} displayStream={null} name={tile.name} videoEnabled={false} />;
  } else if (remoteSharing) {
    videoSlot = screenPrimary
      ? <RemoteVideoTile stream={ctx.remoteStreams[tile.participant_id]} name={tile.name} videoEnabled={tile.video_enabled} isScreenSharing />
      : <RemoteVideoTile stream={undefined} name={tile.name} videoEnabled={false} />;
  } else if (tile.is_self) {
    videoSlot = <LocalVideoTile stream={ctx.localStream} streamRef={ctx.localStreamRef} displayStream={null} name={tile.name} videoEnabled={tile.video_enabled} />;
  } else {
    videoSlot = <RemoteVideoTile stream={ctx.remoteStreams[tile.participant_id]} name={tile.name} videoEnabled={tile.video_enabled} />;
  }

  // Badge text is a stable contract (e2e suites match these exact strings).
  const badge = tile.is_self
    ? tile.is_screen_sharing ? "You are sharing your screen" : "You"
    : tile.is_screen_sharing ? `${tile.name} is sharing` : "Remote video";
  const pinned = ctx.pinnedParticipantId === tile.participant_id;
  const meta = thumb ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-1";

  return (
    <div
      className={`group relative bg-[#171d27] rounded-xl overflow-hidden shadow-xl border border-white/10 ${pinned ? "ring-2 ring-[#2f6fed] border-transparent" : ""} ${className}`}
      data-participant-tile={tile.participant_id}
    >
      {videoSlot}
      <div className={`${thumb ? "text-[10px]" : "text-xs"} absolute top-2 left-2 z-10 bg-black/50 rounded-md px-2 py-1 pointer-events-none`}>{badge}</div>
      {pinned && <div className={`${thumb ? "text-[10px] right-10" : "text-xs right-11"} absolute top-2 z-10 flex items-center gap-1 bg-[#2f6fed] rounded-md px-2 py-1 pointer-events-none`}><Pin className="w-3 h-3" />Pinned</div>}
      <button
        onClick={() => ctx.onTogglePin(tile.participant_id)}
        aria-label={pinned ? `Unpin ${tile.name}` : `Pin ${tile.name}`}
        title={pinned ? `Unpin ${tile.name}` : `Pin ${tile.name}`}
        className={`absolute top-2 right-2 z-10 ${thumb ? "w-6 h-6" : "w-7 h-7"} rounded-lg bg-black/50 hover:bg-black/70 text-slate-300 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity`}
      >
        <Pin className={`${thumb ? "w-3 h-3" : "w-3.5 h-3.5"} ${pinned ? "fill-current text-[#2f6fed]" : ""}`} />
      </button>
      <div className={`${meta} absolute bottom-2 left-2 z-10 bg-black/60 rounded-md font-medium flex items-center gap-1 max-w-[calc(100%-1rem)]`}>
        <span className="truncate">{tile.name}</span>
        {tile.role === "host" && <Crown className="w-3 h-3 text-amber-300 shrink-0" />}
        {!tile.audio_enabled && <MicOff className="w-3 h-3 text-red-400 shrink-0" />}
      </div>
    </div>
  );
}

/** Equal-sized tiles in a responsive grid: 2 wide on phones, up to 4 on desktop. */
export function GalleryLayout({ tiles, ctx }: { tiles: TileParticipant[]; ctx: TileContext }) {
  const count = tiles.length;
  const columns = count <= 1 ? "grid-cols-1" : count <= 4 ? "grid-cols-2" : count <= 9 ? "grid-cols-2 lg:grid-cols-3" : "grid-cols-2 lg:grid-cols-4";
  const tileMax = count <= 2 ? "max-w-3xl" : count <= 4 ? "max-w-2xl" : "max-w-xl";
  return (
    <div className={`min-h-full w-full grid ${columns} gap-3 place-content-center justify-items-center p-1`} data-layout="gallery">
      {tiles.map((tile) => (
        <ParticipantTile key={tile.participant_id} tile={tile} ctx={ctx} className={`w-full aspect-video ${tileMax}`} />
      ))}
    </div>
  );
}

/** One large primary (pinned participant, else the first remote, else self) above a horizontal thumbnail strip. */
export function SpeakerLayout({ primary, secondary, ctx }: { primary: TileParticipant | null; secondary: TileParticipant[]; ctx: TileContext }) {
  return (
    <div className="h-full w-full flex flex-col gap-3" data-layout="speaker">
      <div className="flex-1 min-h-0 flex items-center justify-center">
        {primary && <ParticipantTile tile={primary} ctx={ctx} className="h-full max-h-full w-auto max-w-full aspect-video" />}
      </div>
      {secondary.length > 0 && (
        <div className="shrink-0 flex gap-3 overflow-x-auto pb-1">
          {secondary.map((tile) => (
            <ParticipantTile key={tile.participant_id} tile={tile} ctx={ctx} thumb className="shrink-0 w-32 sm:w-40 md:w-48 aspect-video" />
          ))}
        </div>
      )}
    </div>
  );
}

/** Primary left with a vertical filmstrip sidebar on desktop; collapses to a speaker-like column on mobile. */
export function MultiSpeakerLayout({ primary, secondary, ctx }: { primary: TileParticipant | null; secondary: TileParticipant[]; ctx: TileContext }) {
  return (
    <div className="h-full w-full flex flex-col md:flex-row gap-3 min-h-0" data-layout="multi-speaker">
      <div className="flex-1 min-h-0 flex items-center justify-center">
        {primary && <ParticipantTile tile={primary} ctx={ctx} className="h-full max-h-full w-auto max-w-full aspect-video" />}
      </div>
      <div className="shrink-0 flex md:flex-col gap-3 overflow-x-auto md:overflow-x-hidden md:overflow-y-auto pb-1 md:pb-0 md:w-[23%]">
        {secondary.map((tile) => (
          <ParticipantTile key={tile.participant_id} tile={tile} ctx={ctx} thumb className="shrink-0 w-36 md:w-full aspect-video" />
        ))}
      </div>
    </div>
  );
}

/**
 * Screen share as the dominant element (~79% of the stage on desktop) with a
 * participant strip beside it. The sharer's own tile IS the primary — their
 * stream (camera replaced by the screen via replaceTrack) renders exactly
 * once, and their strip entry is an avatar.
 */
export function PresentationLayout({ sharer, strip, ctx }: { sharer: TileParticipant; strip: TileParticipant[]; ctx: TileContext }) {
  return (
    <div className="h-full w-full flex flex-col md:flex-row gap-3 min-h-0" data-layout="presentation">
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <ParticipantTile tile={sharer} ctx={ctx} screenPrimary className="h-full max-h-full w-auto max-w-full aspect-video" />
      </div>
      {strip.length > 0 && (
        <div className="shrink-0 flex md:flex-col gap-3 overflow-x-auto md:overflow-x-hidden md:overflow-y-auto pb-1 md:pb-0 md:w-[21%]">
          {strip.map((tile) => (
            <ParticipantTile key={tile.participant_id} tile={tile} ctx={ctx} thumb className="shrink-0 w-36 md:w-full aspect-video" />
          ))}
        </div>
      )}
    </div>
  );
}

/** Zoom-style checkmark row for the View menu (radio semantics — one layout at a time). */
export function ViewMenuRadio({ icon, label, checked, onClick }: { icon: ReactNode; label: string; checked: boolean; onClick: () => void }) {
  return (
    <button role="menuitemradio" aria-checked={checked} onClick={onClick} className="w-full flex items-center gap-3 text-sm text-slate-200 hover:bg-white/10 rounded-lg px-3 py-2 text-left">
      <span className="text-slate-400">{icon}</span>
      <span className="flex-1">{label}</span>
      <span className={checked ? "text-white" : "text-transparent"}><Check className="w-4 h-4" /></span>
    </button>
  );
}

/** Checkmark row for the View menu's on/off toggles. */
export function ViewMenuToggle({ icon, label, checked, onClick }: { icon: ReactNode; label: string; checked: boolean; onClick: () => void }) {
  return (
    <button role="menuitemcheckbox" aria-checked={checked} onClick={onClick} className="w-full flex items-center gap-3 text-sm text-slate-200 hover:bg-white/10 rounded-lg px-3 py-2 text-left">
      <span className="text-slate-400">{icon}</span>
      <span className="flex-1">{label}</span>
      <span className={checked ? "text-white" : "text-transparent"}><Check className="w-4 h-4" /></span>
    </button>
  );
}
