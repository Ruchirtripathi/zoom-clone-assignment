"use client";

import {
  Clipboard, Copy, Crown, Expand, Info, Keyboard,
  MessageSquare, Mic, MicOff, Monitor, MoreHorizontal, PhoneOff, Send,
  Share2, Sparkles, SmilePlus, Users, Video, VideoOff, X, Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMeetingSocket } from "../hooks/useMeetingSocket";
import { useLocalMedia } from "../hooks/useLocalMedia";
import { useWebRTC } from "../hooks/useWebRTC";
import LocalVideoTile from "./LocalVideoTile";
import RemoteVideoTile from "./RemoteVideoTile";
import { apiUrl } from "../lib/api";
import { invitationUrl } from "../lib/invite";
import type { MeetingSummary } from "../lib/types";
import type { ExitReason } from "./MeetingExitScreen";

const reactions = ["👍", "❤️", "😂", "👏", "🎉", "😮", "😢", "👎"];
// Fullscreen is feature-detected once — the More menu hides the entry when
// the browser (or an embedding context) disallows it, so the label never lies.
const fullscreenSupported = typeof document !== "undefined" && !!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function";

type Participant = {
  participant_id: string;
  name: string;
  role: string;
  audio_enabled: boolean;
  video_enabled: boolean;
  is_screen_sharing: boolean;
};

type ChatMessage = { id: string; sender_id: string; sender_name: string; content: string; timestamp: string };
type ToastReaction = { id: number; name: string; reaction: string };
type ConfirmExit = { title: string; body: string; confirmLabel: string; action: () => void };

// Union of the messages we already hold and a (possibly overlapping) page of
// history, deduplicated by the server-generated message id and ordered by
// timestamp — realtime and history are one list, never two.
function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) if (!byId.has(message.id)) byId.set(message.id, message);
  return Array.from(byId.values()).sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
}

export interface MeetingRoomProps {
  meeting: MeetingSummary;
  participantId: string;
  name: string;
  /**
   * The single local-media instance for this join, owned by the room
   * controller. It may already carry a live stream from the join lobby —
   * the room never calls getUserMedia again.
   */
  localMedia: ReturnType<typeof useLocalMedia>;
  /** Exit with an explicit reason; the controller renders the matching end screen. */
  onExit: (reason: ExitReason, details?: { isHost?: boolean }) => void;
}

export default function MeetingRoom({ meeting, participantId, name, localMedia, onExit }: MeetingRoomProps) {
  const meeting_id = meeting.meeting_id;

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const signalHandlerRef = useRef<(message: Record<string, unknown>) => void>(() => undefined);
  const stopScreenShareRef = useRef<() => void>(() => undefined);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [chatUnread, setChatUnread] = useState(0);
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  // Who is currently sharing, other than ourselves. Our own sharing state
  // lives in useWebRTC (screenStream is its single source of truth).
  const [remoteSharerId, setRemoteSharerId] = useState<string | null>(null);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [openPanel, setOpenPanel] = useState<"participants" | "chat" | "ai" | "info" | null>(null);
  const [showReactions, setShowReactions] = useState(false);
  const [showHostTools, setShowHostTools] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [reactionToasts, setReactionToasts] = useState<ToastReaction[]>([]);
  const [aiSummary, setAiSummary] = useState<{ mode: string; summary: string; key_points: string[]; action_items: string[]; questions: string[] } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [confirmExit, setConfirmExit] = useState<ConfirmExit | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const localParticipant = useMemo(() => participants.find((item) => item.participant_id === participantId), [participants, participantId]);
  const isHost = localParticipant?.role === "host";
  const remoteParticipants = participants.filter((item) => item.participant_id !== participantId);
  // The invite link is the bare room URL — never the current href, which
  // carries this browser's participant_id and must not be shared.
  const inviteLink = invitationUrl(meeting_id);

  const {
    stream,
    streamRef: localStreamRef,
    isAudioEnabled,
    isVideoEnabled,
    toggleAudio: toggleLocalAudio,
    toggleVideo: toggleLocalVideo,
    setAudioEnabled,
    startMedia,
    stopMedia,
    error: mediaError,
  } = localMedia;
  const isMuted = !isAudioEnabled;
  const isVideoOff = !isVideoEnabled;

  // Single dispatch point for every server event. The chat-open check reads
  // `openPanel` from this render's closure — useMeetingSocket re-points its
  // onMessage ref on every render, so the value is always current.
  const handleSocketMessage = (data: Record<string, unknown>) => {
    const type = typeof data.type === "string" ? data.type : "";
    switch (type) {
      case "room_state": {
        const roomParticipants = Array.isArray(data.participants) ? data.participants as Participant[] : [];
        setParticipants(roomParticipants);
        // A late joiner may land mid-share: room_state carries the sharer flag.
        const sharer = roomParticipants.find((item) => item.is_screen_sharing && item.participant_id !== participantId);
        setRemoteSharerId(sharer ? sharer.participant_id : null);
        break;
      }
      case "participant_joined":
        setParticipants((current) => current.some((item) => item.participant_id === data.participant_id) ? current : [...current, data as unknown as Participant]);
        break;
      case "participant_left":
      case "participant_removed":
        setParticipants((current) => current.filter((item) => item.participant_id !== data.participant_id));
        setRemoteSharerId((current) => current === data.participant_id ? null : current);
        if (type === "participant_removed" && data.participant_id === participantId) {
          // We are the target: stop every local source (camera, microphone,
          // screen share), close all peer connections — the socket closes on
          // unmount — and exit with the removal reason. Realtime can never
          // rebuild the room afterwards: closeAllPeerConnections latches
          // permanentlyClosedRef for good on exit (the tracks are stopped,
          // so the StrictMode re-arm cannot fire).
          exitRoom("kicked");
        }
        break;
      // Remote media state: SET the value received from the server — never
      // toggle. Duplicate events are harmless by design.
      case "audio_state_changed":
        setParticipants((current) => current.map((item) => item.participant_id === data.participant_id ? { ...item, audio_enabled: data.audio_enabled === true } : item));
        break;
      case "video_state_changed":
        setParticipants((current) => current.map((item) => item.participant_id === data.participant_id ? { ...item, video_enabled: data.video_enabled === true } : item));
        break;
      // Screen-share metadata: the pixels travel through WebRTC (replaceTrack);
      // these events only tell the room who is sharing.
      case "screen_share_started":
      case "screen_share_stopped": {
        const sharing = type === "screen_share_started";
        setParticipants((current) => current.map((item) => item.participant_id === data.participant_id ? { ...item, is_screen_sharing: sharing } : item));
        setRemoteSharerId((current) => sharing ? String(data.participant_id) : current === data.participant_id ? null : current);
        break;
      }
      case "offer":
      case "answer":
      case "ice_candidate":
        signalHandlerRef.current(data);
        break;
      case "chat_message": {
        // Canonical server event, normalized to the same shape as chat
        // history so both merge by id. No optimistic local echo exists — the
        // broadcast (which includes the sender) is the only insert path.
        const message: ChatMessage = {
          id: String(data.message_id ?? ""),
          sender_id: String(data.sender_id ?? ""),
          sender_name: String(data.sender_name ?? ""),
          content: String(data.content ?? ""),
          timestamp: String(data.timestamp ?? ""),
        };
        setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
        if (openPanel !== "chat" && message.sender_id !== participantId) setChatUnread((count) => count + 1);
        break;
      }
      case "reaction": {
        // Ephemeral by design: rendered as a floating pill that rises and
        // fades out (see .reaction-toast), then unmounts. The list is capped
        // so a burst from several participants cannot pile up.
        const toast = { id: Date.now() + Math.random(), name: String(data.participant_name), reaction: String(data.reaction) };
        setReactionToasts((current) => [...current.slice(-7), toast]);
        setTimeout(() => setReactionToasts((current) => current.filter((item) => item.id !== toast.id)), 3000);
        break;
      }
      case "mute_all":
        // Moderation command: each browser disables its OWN local track (the
        // server cannot reach into another browser). The initiator is never
        // muted, and a no-op when we are already muted avoids publishing a
        // redundant audio_state_changed. Disabling the track below is what
        // publishes audio_state_changed — exactly once, by design.
        if (data.initiated_by === participantId) break;
        if (!isMuted) setAudioEnabled(false);
        break;
      case "meeting_ended":
        exitRoom("ended");
        break;
      case "error":
        if (data.code === "NOT_AUTHORIZED") {
          // The server refused our session: a removed participant trying to
          // reconnect with a stale identity, or the meeting ended while we
          // were away. Not a transport hiccup — never retried, exit instead.
          exitRoom("denied");
          break;
        }
        if (data.code === "SCREEN_SHARE_ACTIVE") {
          // We optimistically started sharing; the room already had a sharer
          // (client-side gate lost a race). Roll back locally — the server never
          // broadcast our start, so no one else needs to be told.
          stopScreenShareRef.current();
          setShareNotice(String(data.message || "Someone else is currently sharing their screen."));
          break;
        }
        if (data.code === "INVALID_CHAT_MESSAGE" || data.code === "CHAT_MESSAGE_TOO_LONG") {
          setChatNotice(String(data.message || "Message could not be sent."));
          break;
        }
        if (data.code === "FORBIDDEN" || data.code === "INVALID_TARGET" || data.code === "CANNOT_REMOVE_SELF" || data.code === "INVALID_REACTION") {
          // Host-control and reaction rejections are notices, not alerts.
          setActionNotice(String(data.message || "Unable to perform this action."));
          break;
        }
        setActionNotice(String(data.message || "WebSocket error"));
        break;
      default:
        break;
    }
  };

  const { status, sendMessage } = useMeetingSocket({
    meetingId: String(meeting_id || ""),
    participantId,
    onMessage: handleSocketMessage,
  });

  const { remoteStreams, peerStatuses, isSupported: isWebRTCAvailable, closeAllPeerConnections, handleSignal, screenStream, isScreenSharing, startScreenShare, stopScreenShare } = useWebRTC({
    participantId,
    participants,
    localStream: stream,
    sendMessage,
  });
  signalHandlerRef.current = handleSignal;
  stopScreenShareRef.current = stopScreenShare;

  const sendEvent = (payload: Record<string, unknown>) => {
    sendMessage(payload);
  };

  // Local media metadata. The MediaStreamTrack stays the source of truth;
  // each effect publishes its current state through the existing WebSocket.
  // One path covers every cause — initial sync after connecting, toolbar
  // toggles, host mute-all, track loss, and reconnects.
  useEffect(() => {
    if (stream && status === "connected") {
      sendMessage({ type: "audio_state_changed", audio_enabled: isAudioEnabled });
    }
  }, [isAudioEnabled, status, stream, sendMessage]);

  useEffect(() => {
    if (stream && status === "connected") {
      sendMessage({ type: "video_state_changed", video_enabled: isVideoEnabled });
    }
  }, [isVideoEnabled, status, stream, sendMessage]);

  const isChatOpen = openPanel === "chat";

  // Chat history loads when the panel opens (never through room_state) and
  // merges with messages already received live, deduplicated by message id.
  useEffect(() => {
    if (!isChatOpen || !meeting_id) return;
    let cancelled = false;
    (async () => {
      try {
        const chatResponse = await fetch(`${apiUrl}/api/meetings/${meeting_id}/chat`);
        if (!chatResponse.ok || cancelled) return;
        const history = await chatResponse.json() as ChatMessage[];
        setMessages((current) => mergeMessages(current, history));
      } catch { /* The socket status remains authoritative for transport state. */ }
    })();
    return () => { cancelled = true; };
  }, [isChatOpen, meeting_id]);

  // Opening the panel lands on the newest message.
  useEffect(() => {
    if (!isChatOpen) return;
    const container = chatScrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [isChatOpen]);

  // New messages follow only when the reader is already near the bottom;
  // someone scrolled up to read history is never yanked down.
  useEffect(() => {
    const container = chatScrollRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distance < 80) container.scrollTop = container.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!chatNotice) return;
    const timer = setTimeout(() => setChatNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [chatNotice]);

  useEffect(() => {
    if (!shareNotice) return;
    const timer = setTimeout(() => setShareNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [shareNotice]);

  const openChat = () => { setOpenPanel("chat"); setChatUnread(0); };
  const closeChat = () => setOpenPanel(null);
  const sendChat = () => {
    const content = messageDraft.trim();
    if (!content) return;
    // No optimistic insert: the server's canonical broadcast is the only
    // path that renders the message. On failure the draft is kept so the
    // message is never silently lost.
    if (!sendMessage({ type: "chat_message", content })) {
      setChatNotice("Message could not be sent.");
      return;
    }
    setMessageDraft("");
  };
  const sendReaction = (reaction: string) => { sendEvent({ type: "reaction", reaction }); setShowReactions(false); };
  const toggleShare = async () => {
    if (isScreenSharing) { stopScreenShare(); return; }
    // One active sharer per meeting: gate before even opening the picker.
    // (The server enforces the same rule for races we cannot see.)
    if (remoteSharerId) {
      const sharer = participants.find((item) => item.participant_id === remoteSharerId);
      setShareNotice(`${sharer?.name ?? "Another participant"} is currently sharing their screen.`);
      return;
    }
    const result = await startScreenShare();
    if (!result.ok) setShareNotice(result.message);
  };
  // Full teardown for a server-driven exit (removed / meeting ended / access
  // revoked): close all peer connections — which also stops screen share —
  // stop camera and microphone, then hand the explicit reason to the
  // controller, which swaps in the matching end screen. The WebSocket closes
  // when this component unmounts. Cleanup happens BEFORE any state or URL
  // change; nothing downstream can rebuild the room after removal.
  const exitRoom = (reason: ExitReason) => {
    closeAllPeerConnections();
    stopMedia();
    onExit(reason, { isHost });
  };
  // Host: end for everyone. The server broadcasts meeting_ended to the whole
  // room INCLUDING us, so our own cleanup flows through the same handler as
  // everyone else's — one code path, no double cleanup.
  const endMeeting = () => {
    setConfirmExit(null);
    if (!sendMessage({ type: "meeting_ended" })) setActionNotice("The meeting could not be ended. Check your connection.");
  };
  // Participant: leave quietly. Others learn through participant_left when
  // this socket closes; no meeting_ended is ever sent. The exit screen for a
  // voluntary leave differs from removal — the reason is explicit, never
  // inferred from the navigation itself.
  const leaveMeeting = async () => {
    setConfirmExit(null);
    try { await fetch(`${apiUrl}/api/meetings/${meeting_id}/leave`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ participant_id: participantId }) }); } catch { /* WebSocket cleanup still notifies the room. */ }
    closeAllPeerConnections();
    stopMedia();
    onExit("left", { isHost });
  };
  const muteAll = () => { sendEvent({ type: "mute_all" }); setShowHostTools(false); };
  const removeParticipant = (targetId: string) => { sendEvent({ type: "remove_participant", target_participant_id: targetId }); setShowHostTools(false); };
  const copyText = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setToast(message);
    } catch {
      setToast("Copy failed. Your browser blocked clipboard access.");
    }
  };
  const toggleFullscreen = async () => {
    setShowMore(false);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* Unavailable or blocked — the button simply does nothing. */ }
  };
  // Only the host gets a confirmation ("End meeting for everyone?" is
  // destructive for everyone). Participants leave immediately — Phase 2-8
  // behavior, preserved per spec.
  const hostEndConfirm: ConfirmExit = { title: "End meeting for everyone?", body: "All participants will be disconnected and the meeting will be marked as ended.", confirmLabel: "End Meeting", action: endMeeting };
  const generateSummary = async () => {
    setAiLoading(true);
    try { const response = await fetch(`${apiUrl}/api/meetings/${meeting_id}/ai/summary`, { method: "POST" }); if (response.ok) setAiSummary(await response.json()); }
    finally { setAiLoading(false); }
  };

  useEffect(() => {
    if (!actionNotice) return;
    const timer = setTimeout(() => setActionNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [actionNotice]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  // Fullscreen state follows the browser (the user can also leave fullscreen
  // with Esc or the browser's own UI), so the menu label stays truthful.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Keyboard shortcuts. Never while typing in an input, never with modifier
  // keys (those belong to the browser), never while a dialog is open. On any
  // exit the whole component unmounts, taking the listener with it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenPanel(null); setShowReactions(false); setShowHostTools(false); setShowMore(false); setShowShortcuts(false); setConfirmExit(null);
        return;
      }
      if (confirmExit || showShortcuts) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      switch (event.key.toLowerCase()) {
        case "m": toggleLocalAudio(); break;
        case "v": toggleLocalVideo(); break;
        case "c": openPanel === "chat" ? setOpenPanel(null) : openChat(); break;
        case "p": setOpenPanel(openPanel === "participants" ? null : "participants"); break;
        case "s": toggleShare(); break;
        case "r": setShowReactions((current) => !current); break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openPanel, confirmExit, showShortcuts, toggleLocalAudio, toggleLocalVideo, toggleShare]);

  // Floating menus close when clicking anywhere outside them (their own
  // toggle buttons are excluded so a second click still toggles).
  useEffect(() => {
    if (!showReactions && !showHostTools && !showMore) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-floating-menu]") || target?.closest("[data-menu-toggle]")) return;
      setShowReactions(false); setShowHostTools(false); setShowMore(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [showReactions, showHostTools, showMore]);

  return (
    <div className="meeting-room flex flex-col bg-[#0d1117] text-white w-full relative" style={{ height: "100dvh" }}>
      <header className="flex items-center justify-between px-4 md:px-6 py-3 bg-[#151a22] border-b border-white/10 z-20">
        <div className="flex items-center gap-3"><div className="w-8 h-8 rounded-lg bg-[#2f6fed] flex items-center justify-center font-semibold text-sm">M</div><div className="min-w-0"><div className="font-semibold text-sm truncate">{meeting.title || `${name}'s meeting`}</div><div className="text-[11px] text-slate-400">ID: {meeting_id}</div></div><button onClick={() => copyText(inviteLink, "Meeting link copied")} className="w-8 h-8 rounded-lg text-slate-300 hover:bg-white/10 flex items-center justify-center" aria-label="Copy invite link"><Copy className="w-4 h-4" /></button></div>
        <div className="flex items-center gap-2 text-xs text-slate-300">{(isScreenSharing || remoteSharerId) && <span className="flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2.5 py-1 text-emerald-300"><Monitor className="w-3.5 h-3.5" />{isScreenSharing ? "You are sharing" : `${participants.find((item) => item.participant_id === remoteSharerId)?.name ?? "Someone"} is sharing`}</span>}<span className={`w-2 h-2 rounded-full ${status === "connected" ? "bg-emerald-400" : status === "reconnecting" || status === "connecting" ? "bg-amber-400" : "bg-red-400"}`} /> {status === "connected" ? "Connected" : status === "reconnecting" ? "Reconnecting" : status === "connecting" ? "Connecting" : "Disconnected"}{remoteParticipants.length > 0 && <span className="ml-2 text-slate-500" title={Object.entries(peerStatuses).map(([id, peerStatus]) => `${id.slice(0, 8)}: ${peerStatus}`).join("\n") || "No peer connections yet"}>· P2P {remoteParticipants.length}</span>}</div>
      </header>

      <main className="flex-1 relative overflow-y-auto p-4 pb-28 flex flex-wrap content-center justify-center gap-4">
        {!isWebRTCAvailable && <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 max-w-[calc(100%-2rem)] rounded-xl border border-red-300/20 bg-red-400/10 px-4 py-2 text-center text-xs text-red-100">Your browser does not support WebRTC. You can use chat, but live audio and video are unavailable.</div>}
        {shareNotice && <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 max-w-[calc(100%-2rem)] rounded-xl border border-amber-300/20 bg-amber-400/10 px-4 py-2 text-center text-xs text-amber-100">{shareNotice}<button onClick={() => setShareNotice(null)} className="ml-3 font-semibold underline underline-offset-2">Dismiss</button></div>}
        {actionNotice && <div role="status" className="absolute top-14 left-1/2 -translate-x-1/2 z-10 max-w-[calc(100%-2rem)] rounded-xl border border-amber-300/20 bg-amber-400/10 px-4 py-2 text-center text-xs text-amber-100">{actionNotice}</div>}
        {mediaError && <div className="absolute top-14 left-1/2 -translate-x-1/2 z-10 max-w-[calc(100%-2rem)] rounded-xl border border-amber-300/20 bg-amber-400/10 px-4 py-2 text-center text-xs text-amber-100">{mediaError.message}<button onClick={() => startMedia()} className="ml-3 font-semibold underline underline-offset-2">Try again</button></div>}
        <div className="relative w-full max-w-xl aspect-video bg-[#171d27] rounded-xl overflow-hidden shadow-2xl border border-white/10"><div className="absolute top-3 left-3 z-10 text-xs bg-black/50 rounded-md px-2 py-1">{isScreenSharing ? "You are sharing your screen" : "You"}</div><LocalVideoTile stream={stream} streamRef={localStreamRef} displayStream={isScreenSharing ? screenStream : null} name={name} videoEnabled={isVideoEnabled} isSharing={isScreenSharing} />{isScreenSharing && <div className="absolute bottom-3 right-3 text-xs bg-emerald-500/90 rounded-md px-2 py-1">Screen sharing</div>}<TileLabel name={name} muted={isMuted} /> </div>
        {remoteParticipants.map((participant) => <div key={participant.participant_id} className="relative w-full max-w-sm aspect-video bg-[#171d27] rounded-xl overflow-hidden shadow-xl border border-white/10"><div className="absolute top-3 left-3 z-10 text-xs bg-black/50 rounded-md px-2 py-1">{participant.is_screen_sharing ? `${participant.name} is sharing` : "Remote video"}</div><RemoteVideoTile stream={remoteStreams[participant.participant_id]} name={participant.name} videoEnabled={participant.video_enabled} isScreenSharing={participant.is_screen_sharing} /><TileLabel name={participant.name} muted={!participant.audio_enabled} host={participant.role === "host"} /></div>)}
        <div className="fixed top-20 right-5 z-30 flex flex-col items-end gap-2 pointer-events-none">{reactionToasts.map((item) => <div key={item.id} data-reaction-toast className="reaction-toast rounded-full bg-white text-slate-900 pl-3 pr-4 py-2 shadow-2xl text-sm font-medium">{item.reaction} <span className="text-slate-500 font-normal">{item.name}</span></div>)}</div>
      </main>

      <div className="absolute bottom-0 left-0 right-0 z-[60] bg-[#151a22]/95 border-t border-white/10 backdrop-blur-md px-2 py-3"><div className="flex items-end justify-center gap-1 sm:gap-3 overflow-x-auto">
        <ControlButton icon={isMuted ? <MicOff /> : <Mic />} label={isMuted ? "Unmute" : "Mute"} active={isMuted} onClick={toggleLocalAudio} />
        <ControlButton icon={isVideoOff ? <VideoOff /> : <Video />} label={isVideoOff ? "Start video" : "Stop video"} active={isVideoOff} onClick={toggleLocalVideo} />
        <ControlButton icon={<Users />} label="Participants" badge={participants.length} active={openPanel === "participants"} onClick={() => { setOpenPanel(openPanel === "participants" ? null : "participants"); setShowHostTools(false); }} />
        <ControlButton icon={<MessageSquare />} label="Chat" badge={chatUnread} active={openPanel === "chat"} onClick={() => { isChatOpen ? closeChat() : openChat(); }} />
        <ControlButton icon={<SmilePlus />} label="React" active={showReactions} menuToggle onClick={() => setShowReactions(!showReactions)} />
        <ControlButton icon={<Share2 />} label={isScreenSharing ? "Stop share" : "Share"} active={isScreenSharing} onClick={toggleShare} />
        {isHost && <ControlButton icon={<Crown />} label="Host tools" active={showHostTools} menuToggle onClick={() => { setShowHostTools(!showHostTools); setOpenPanel(null); }} />}
        <ControlButton icon={<Sparkles />} label="Zoom AI" active={openPanel === "ai"} onClick={() => { setOpenPanel(openPanel === "ai" ? null : "ai"); setShowHostTools(false); }} />
        <ControlButton icon={<MoreHorizontal />} label="More" active={showMore} menuToggle onClick={() => setShowMore(!showMore)} />
        <ControlButton icon={<PhoneOff />} label="End" danger onClick={() => (isHost ? setConfirmExit(hostEndConfirm) : leaveMeeting())} />
      </div></div>

      {showReactions && <FloatingMenu className="bottom-24 left-1/2 -translate-x-1/2 max-w-[calc(100vw-2rem)]"><div className="flex flex-wrap justify-center gap-2">{reactions.map((reaction) => <button key={reaction} onClick={() => sendReaction(reaction)} className="text-2xl hover:scale-125 transition-transform p-1" aria-label={`Send ${reaction}`}>{reaction}</button>)}</div></FloatingMenu>}
      {showHostTools && <FloatingMenu className="bottom-24 left-1/2 -translate-x-1/2 w-72"><div className="flex items-center justify-between mb-3"><strong className="text-sm">Host tools</strong></div><div className="space-y-1"><MenuButton icon={<MicOff />} label="Mute all" onClick={muteAll} /><MenuButton icon={<Users />} label="Manage participants" onClick={() => { setOpenPanel("participants"); setShowHostTools(false); }} /><MenuButton icon={<PhoneOff />} label="End meeting" onClick={() => { setShowHostTools(false); setConfirmExit(hostEndConfirm); }} /></div></FloatingMenu>}
      {showMore && <FloatingMenu className="bottom-24 right-4 w-56"><MenuButton icon={<Info />} label="Meeting info" onClick={() => { setOpenPanel("info"); setShowMore(false); }} />{fullscreenSupported && <MenuButton icon={<Expand />} label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={toggleFullscreen} />}<MenuButton icon={<Keyboard />} label="Keyboard shortcuts" onClick={() => { setShowShortcuts(true); setShowMore(false); }} /></FloatingMenu>}
      {openPanel === "participants" && <SidePanel title={`Participants (${participants.length})`} onClose={() => setOpenPanel(null)}><div className="space-y-1">{participants.map((participant) => {
        const self = participant.participant_id === participantId;
        // Our own row reads the local media hook — the live track state —
        // because our own media events are broadcast to others, not to us.
        const audioOn = self ? isAudioEnabled : participant.audio_enabled;
        const videoOn = self ? isVideoEnabled : participant.video_enabled;
        return <div key={participant.participant_id} className="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-white/5"><Avatar name={participant.name} /><div className="min-w-0 flex-1"><div className="text-sm truncate">{participant.name}{self ? " (you)" : ""}</div><div className="text-[11px] text-slate-400">{participant.role === "host" ? "Host" : "Participant"}</div></div><span className={`flex items-center justify-center w-7 h-7 rounded-lg shrink-0 ${audioOn ? "text-slate-400" : "text-red-400 bg-red-400/10"}`} title={audioOn ? "Microphone on" : "Microphone muted"} aria-label={audioOn ? "Microphone on" : "Microphone muted"}>{audioOn ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}</span><span className={`flex items-center justify-center w-7 h-7 rounded-lg shrink-0 ${videoOn ? "text-slate-400" : "text-red-400 bg-red-400/10"}`} title={videoOn ? "Camera on" : "Camera off"} aria-label={videoOn ? "Camera on" : "Camera off"}>{videoOn ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}</span>{isHost && !self && <button onClick={() => removeParticipant(participant.participant_id)} className="shrink-0 text-xs rounded-lg px-2 py-1.5 text-red-300 hover:text-red-200 hover:bg-red-400/10" aria-label={`Remove ${participant.name} from meeting`}>Remove</button>}</div>;
      })}</div></SidePanel>}
      {openPanel === "chat" && <SidePanel title="Chat" onClose={closeChat}><div className="flex flex-col h-full"><div ref={chatScrollRef} className="flex-1 overflow-y-auto space-y-3">{messages.length === 0 ? <div className="h-full flex items-center justify-center text-sm text-slate-500 text-center">No messages yet.<br />Start the conversation.</div> : messages.map((message) => <div key={message.id} className={`max-w-[88%] ${message.sender_id === participantId ? "ml-auto text-right" : ""}`}><div className="text-[11px] text-slate-500 mb-1">{message.sender_id === participantId ? "You" : message.sender_name} - {new Date(message.timestamp || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div><div className={`inline-block rounded-2xl px-3 py-2 text-sm ${message.sender_id === participantId ? "bg-[#2f6fed] text-white" : "bg-white/10 text-slate-200"}`}>{message.content}</div></div>)}</div>{chatNotice && <div role="status" className="pt-2 text-xs text-amber-300">{chatNotice}</div>}{status !== "connected" && <div role="status" className="pt-2 text-xs text-amber-300">Reconnecting… Messages cannot be sent right now.</div>}<div className="pt-4 flex gap-2"><input value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") sendChat(); }} placeholder="Message everyone" aria-label="Chat message input" disabled={status !== "connected"} className="flex-1 min-w-0 rounded-xl bg-white/10 border border-white/10 px-3 py-2 text-sm outline-none focus:border-blue-400 disabled:opacity-50" /><button onClick={sendChat} disabled={status !== "connected"} className="w-10 rounded-xl bg-[#2f6fed] flex items-center justify-center disabled:opacity-50" aria-label="Send message"><Send className="w-4 h-4" /></button></div></div></SidePanel>}
      {openPanel === "ai" && <SidePanel title="Meeting assistant" onClose={() => setOpenPanel(null)}><div className="space-y-5"><div className="rounded-xl bg-[#2f6fed]/15 border border-blue-400/20 p-4"><div className="flex gap-2 items-center text-sm font-semibold"><Zap className="w-4 h-4 text-amber-300" /> Demo assistant mode</div><p className="text-xs text-slate-400 mt-2">This uses the local deterministic fallback. Connect an AI provider before treating summaries as production output.</p></div><button onClick={generateSummary} disabled={aiLoading} className="w-full rounded-xl bg-[#2f6fed] px-4 py-3 text-sm font-semibold disabled:opacity-50">{aiLoading ? "Generating..." : "Generate summary"}</button>{aiSummary && <div className="space-y-4 text-sm"><p className="text-slate-300">{aiSummary.summary}</p><Section title="Key points" items={aiSummary.key_points} /><Section title="Action items" items={aiSummary.action_items} /><Section title="Questions" items={aiSummary.questions} /></div>}</div></SidePanel>}
      {openPanel === "info" && <SidePanel title="Meeting info" onClose={() => setOpenPanel(null)}><div className="space-y-4 text-sm"><InfoRow label="Meeting title" value={meeting.title || `${name}'s meeting`} /><InfoRow label="Meeting ID" value={String(meeting_id)} copy={() => copyText(String(meeting_id), "Meeting ID copied")} /><InfoRow label="Host" value={participants.find((item) => item.role === "host")?.name || "Host"} />{meeting.scheduled_at && <InfoRow label="Scheduled for" value={new Date(meeting.scheduled_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} />}<InfoRow label="Invite link" value={inviteLink} copy={() => copyText(inviteLink, "Meeting link copied")} /></div></SidePanel>}
      {toast && <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[85] rounded-xl bg-white text-slate-900 px-4 py-2 text-sm font-medium shadow-2xl">{toast}</div>}
      {confirmExit && <div role="dialog" aria-modal="true" aria-label={confirmExit.title} className="fixed inset-0 z-[90] bg-black/60 flex items-center justify-center p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmExit(null); }}><div className="w-full max-w-sm rounded-2xl bg-[#20252d] border border-white/10 shadow-2xl p-6"><h2 className="text-base font-semibold">{confirmExit.title}</h2><p className="mt-2 text-sm text-slate-400">{confirmExit.body}</p><div className="mt-6 flex justify-end gap-2"><button onClick={() => setConfirmExit(null)} className="rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold hover:bg-white/20">Cancel</button><button onClick={confirmExit.action} className="rounded-xl bg-[#e5484d] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#c9403f]">{confirmExit.confirmLabel}</button></div></div></div>}
      {showShortcuts && <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="fixed inset-0 z-[90] bg-black/60 flex items-center justify-center p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowShortcuts(false); }}><div className="w-full max-w-sm rounded-2xl bg-[#20252d] border border-white/10 shadow-2xl p-6"><div className="flex items-center justify-between mb-4"><h2 className="text-base font-semibold">Keyboard shortcuts</h2><button onClick={() => setShowShortcuts(false)} className="w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center" aria-label="Close shortcuts"><X className="w-5 h-5" /></button></div><div className="space-y-2 text-sm">{[["M", "Toggle microphone"], ["V", "Toggle camera"], ["C", "Toggle chat panel"], ["P", "Toggle participants panel"], ["S", "Toggle screen share"], ["R", "Toggle reaction picker"], ["Esc", "Close menus and panels"]].map(([key, description]) => <div key={key} className="flex items-center justify-between gap-4"><span className="text-slate-400">{description}</span><kbd className="rounded-md bg-white/10 border border-white/10 px-2 py-1 text-xs font-semibold">{key}</kbd></div>)}</div></div></div>}
    </div>
  );
}

function ControlButton({ icon, label, onClick, active, danger, badge, menuToggle }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean; danger?: boolean; badge?: number; menuToggle?: boolean }) { return <button onClick={onClick} data-menu-toggle={menuToggle ? "true" : undefined} className="relative flex flex-col items-center gap-1 min-w-[64px] px-2 py-1 text-[10px] text-slate-300 hover:text-white rounded-xl transition-colors" aria-label={label}><span className={`w-10 h-10 rounded-xl flex items-center justify-center ${danger ? "bg-[#e5484d] text-white" : active ? "bg-white text-slate-900" : "bg-white/10 text-white"}`}>{icon}</span><span className="whitespace-nowrap">{label}</span>{badge ? <span className="absolute top-0 right-1 min-w-4 h-4 rounded-full bg-[#2f6fed] text-[9px] flex items-center justify-center px-1">{badge}</span> : null}</button>; }
function FloatingMenu({ className, children }: { className: string; children: React.ReactNode }) { return <div data-floating-menu className={`fixed z-[80] rounded-2xl bg-[#20252d] border border-white/10 shadow-2xl p-4 ${className}`}>{children}</div>; }
function MenuButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) { return <button onClick={onClick} className="w-full flex items-center gap-3 text-sm text-slate-200 hover:bg-white/10 rounded-lg px-3 py-2 text-left"><span className="text-slate-400">{icon}</span>{label}</button>; }
function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <aside className="fixed top-0 right-0 bottom-0 z-[70] w-full sm:w-[370px] bg-[#20252d] border-l border-white/10 shadow-2xl p-5 pt-6"><div className="flex items-center justify-between mb-5"><h2 className="font-semibold">{title}</h2><button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center" aria-label="Close panel"><X className="w-5 h-5" /></button></div><div className="h-[calc(100%-52px)]">{children}</div></aside>; }
function Avatar({ name, large }: { name: string; large?: boolean }) { return <div className={`${large ? "w-full h-full text-6xl" : "w-9 h-9 text-xs"} rounded-xl bg-[#b96e3d] flex items-center justify-center font-semibold text-white`}>{name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</div>; }
function TileLabel({ name, muted, host }: { name: string; muted: boolean; host?: boolean }) { return <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/60 rounded-md text-xs font-medium flex items-center gap-1">{name}{host && <Crown className="w-3 h-3 text-amber-300" />}{muted && <MicOff className="w-3 h-3 text-red-400" />}</div>; }
function Section({ title, items }: { title: string; items: string[] }) { return <div><h3 className="font-semibold text-xs uppercase tracking-wider text-slate-500 mb-2">{title}</h3><ul className="space-y-1 text-slate-300">{items.map((item) => <li key={item}>- {item}</li>)}</ul></div>; }
function InfoRow({ label, value, copy }: { label: string; value: string; copy?: () => void }) { return <div><div className="text-xs text-slate-500 mb-1">{label}</div><div className="flex items-center gap-2"><span className="truncate text-slate-200">{value}</span>{copy && <button onClick={copy} className="shrink-0 text-slate-400 hover:text-white" aria-label={`Copy ${label}`}><Clipboard className="w-4 h-4" /></button>}</div></div>; }
