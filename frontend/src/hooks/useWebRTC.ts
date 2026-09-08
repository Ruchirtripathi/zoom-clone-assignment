"use client";

/**
 * WebRTC peer-connection manager (mesh topology).
 *
 * ARCHITECTURE
 * - For small rooms (2-4 participants) this implementation uses a mesh topology:
 *   each participant maintains one RTCPeerConnection per other participant.
 *   For N users each browser holds N-1 peer connections. This is intentional —
 *   do not scale this design to large meetings.
 * - The FastAPI WebSocket is the signaling transport, not the media transport.
 *   Audio/video flows directly peer-to-peer; the server only relays
 *   offer/answer/ICE messages and presence events.
 *
 * OWNERSHIP
 * - useLocalMedia()  owns the local MediaStream and its tracks.
 * - useMeetingSocket() owns the signaling WebSocket.
 * - useWebRTC() (this hook) owns RTCPeerConnection objects, remote streams,
 *   and peer lifecycle. MeetingRoom only composes UI.
 *
 * STORAGE RULES
 * - RTCPeerConnection instances are mutable browser objects: they live in a
 *   ref-held Map keyed by remote participant ID, never in React state.
 * - Remote MediaStreams live in a ref-held Map (authoritative) mirrored into
 *   React state (renderable) because MediaStream mutations do not trigger renders.
 * - Peer connection statuses are plain strings and therefore safe as React state.
 * - Signaling is processed strictly sequentially PER SENDER (see
 *   signalQueuesRef): two handlers for one peer must never interleave at
 *   their await points, or the second createAnswer / setRemoteDescription
 *   runs against an already-stable peer (InvalidStateError).
 *
 * SCREEN SHARING
 * - Sharing calls getDisplayMedia and swaps the outgoing video on every
 *   existing peer with RTCRtpSender.replaceTrack(): the sender and its m-line
 *   stay exactly as negotiated, only the media flowing through them changes —
 *   no new peer connection, no offer/answer, no ICE restart.
 * - The camera stream is never destroyed or disabled while sharing; its track
 *   is parked in localStream (enabled state untouched) so stopping restores
 *   exactly what was there before — camera off stays off, mic stays muted.
 * - screenStream is the single source of truth (isScreenSharing is derived
 *   from it). Peers created mid-share attach the screen track in their initial
 *   negotiation (see addLocalTracks), so late joiners receive the screen too.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { MeetingSocketMessage } from "./useMeetingSocket";

type PeerParticipant = { participant_id: string };
type SignalSender = (message: MeetingSocketMessage) => boolean;

export type PeerConnectionStatus = "new" | "connecting" | "connected" | "failed" | "disconnected" | "closed";

export type ScreenShareStartResult = { ok: true } | { ok: false; code: string; message: string };

type UseWebRTCOptions = {
  participantId: string;
  participants: PeerParticipant[];
  localStream: MediaStream | null;
  sendMessage: SignalSender;
};

// Development default. Override with NEXT_PUBLIC_ICE_SERVERS (JSON array) to add TURN later.
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function resolveIceServers(): RTCIceServer[] {
  const configured = process.env.NEXT_PUBLIC_ICE_SERVERS;
  if (!configured) return DEFAULT_ICE_SERVERS;
  try {
    const parsed = JSON.parse(configured) as RTCIceServer[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_ICE_SERVERS;
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
}

function rtcConfiguration(): RTCConfiguration {
  return { iceServers: resolveIceServers() };
}

export function isWebRTCSupported(): boolean {
  return typeof window !== "undefined" && typeof window.RTCPeerConnection !== "undefined";
}

function logWebRTC(message: string) {
  if (process.env.NODE_ENV !== "production") console.info(`[WebRTC] ${message}`);
}

function logWebRTCError(message: string, error: unknown) {
  if (process.env.NODE_ENV !== "production") console.error(`[WebRTC] ${message}`, error);
}

/**
 * getDisplayMedia failures mapped to user-facing messages. A dismissed picker
 * (NotAllowedError / AbortError) is a normal cancel, not a meeting error.
 */
function describeScreenShareError(error: unknown): { code: string; message: string } {
  const code = error instanceof DOMException ? error.name : "SCREEN_SHARE_ERROR";
  if (code === "NotAllowedError" || code === "AbortError") return { code, message: "Screen sharing was cancelled." };
  const messages: Record<string, string> = {
    NotFoundError: "No screen or window was available to share.",
    NotReadableError: "The selected screen could not be captured.",
    InvalidStateError: "Screen sharing could not start because the browser was not ready.",
    TypeError: "Screen sharing is not supported in this browser.",
  };
  return { code, message: messages[code] || "Screen sharing could not be started." };
}

export function useWebRTC({ participantId, participants, localStream, sendMessage }: UseWebRTCOptions) {
  // Stable, non-render storage. Keys are remote participant IDs from Phase 2 presence.
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const offersStartedRef = useRef<Set<string>>(new Set());
  // Peer-generation counter per remote participant. A join churn (socket
  // reconnect) removes and recreates a peer; an answer to the DEAD peer's
  // offer can then land on the NEW peer, pairing its local offer with a
  // mismatched remote answer — ICE never completes and the peer hangs in
  // "connecting" forever. Every peer creation bumps the generation, offers
  // carry it, answers echo it, and the offerer drops answers tagged with an
  // old generation. Deliberately never cleared on peer removal so the
  // counter only ever moves forward.
  const peerGenerationsRef = useRef<Map<string, number>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  // Per-sender FIFO of in-flight signal processing. A join churn (socket
  // reconnect) can deliver a duplicate offer while the first one is still
  // mid-negotiation; without a queue the two handlers interleave and the
  // second createAnswer throws InvalidStateError on a stable peer.
  const signalQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  // Set by closeAllPeerConnections: after a full teardown (leave, removal,
  // meeting end, unmount) the presence effect must never rebuild the mesh.
  // Without this flag, the state updates that follow a teardown (participant
  // list change, local stream -> null) re-run the effect and recreate peers
  // for a browser that is already on its way out. The one false positive is
  // React StrictMode's dev mount -> cleanup -> mount cycle, which also trips
  // closeAllPeerConnections; the presence effect re-arms the flag while the
  // local camera tracks are still live, because a browser that is really
  // exiting has already stopped them (stopMedia runs first).
  const permanentlyClosedRef = useRef(false);

  // Renderable mirrors of the ref-held data.
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [peerStatuses, setPeerStatuses] = useState<Record<string, PeerConnectionStatus>>({});
  // Starts optimistic (matching SSR, where window is undefined) and resolves
  // to the real value after mount — otherwise the "unsupported browser"
  // banner would render into the server HTML and break hydration.
  const [isSupported, setIsSupported] = useState(true);

  // Screen share. The stream is the single source of truth: isScreenSharing is
  // derived from it and the local tile renders it while active. The camera
  // stream (localStream) is never replaced or stopped during a share.
  const screenStreamRef = useRef<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);

  localStreamRef.current = localStream;

  useEffect(() => {
    setIsSupported(isWebRTCSupported());
  }, []);

  const setPeerStatus = useCallback((remoteId: string, status: PeerConnectionStatus) => {
    setPeerStatuses((current) => (current[remoteId] === status ? current : { ...current, [remoteId]: status }));
  }, []);

  const storeRemoteStream = useCallback((remoteId: string, stream: MediaStream) => {
    remoteStreamsRef.current.set(remoteId, stream);
    setRemoteStreams((current) => ({ ...current, [remoteId]: stream }));
  }, []);

  const removeRemoteStream = useCallback((remoteId: string) => {
    remoteStreamsRef.current.delete(remoteId);
    setRemoteStreams((current) => {
      if (!(remoteId in current)) return current;
      const next = { ...current };
      delete next[remoteId];
      return next;
    });
  }, []);

  /**
   * Attach local tracks to a peer connection. Idempotent per track SLOT: a
   * sender already occupying the audio (or video) m-line is never given a
   * second track, so React effects, reconnects, and camera↔screen swaps
   * cannot duplicate senders. While screen sharing, the video slot carries
   * the screen track instead of the camera track — this is what lets a peer
   * created mid-share receive the screen in its initial negotiation, with no
   * renegotiation afterwards.
   */
  const addLocalTracks = useCallback((peer: RTCPeerConnection, remoteId: string) => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const screenTrack = screenStreamRef.current?.getVideoTracks()[0] ?? null;
    stream.getTracks().forEach((track) => {
      if (peer.getSenders().some((sender) => sender.track?.kind === track.kind)) return;
      const trackToSend = track.kind === "video" && screenTrack ? screenTrack : track;
      try {
        peer.addTrack(trackToSend, stream);
        logWebRTC(`Added local ${trackToSend.kind} track to ${remoteId}${trackToSend !== track ? " (screen share)" : ""}`);
      } catch (error) {
        logWebRTCError(`Failed to add local ${track.kind} track to ${remoteId}`, error);
      }
    });
  }, []);

  /**
   * Returns the existing peer connection for a remote participant, creating
   * and wiring one if needed. Calling this twice with the same ID always
   * returns the SAME RTCPeerConnection instance.
   */
  const getOrCreatePeerConnection = useCallback((remoteId: string): RTCPeerConnection | null => {
    const existing = peersRef.current.get(remoteId);
    if (existing) {
      addLocalTracks(existing, remoteId);
      return existing;
    }

    if (!isWebRTCSupported()) {
      logWebRTCError("RTCPeerConnection is not supported by this browser", null);
      return null;
    }

    let peer: RTCPeerConnection;
    try {
      peer = new RTCPeerConnection(rtcConfiguration());
    } catch (error) {
      logWebRTCError(`Failed to create peer connection for ${remoteId}`, error);
      setPeerStatus(remoteId, "failed");
      return null;
    }

    logWebRTC(`Creating peer connection: ${remoteId}`);
    peerGenerationsRef.current.set(remoteId, (peerGenerationsRef.current.get(remoteId) ?? 0) + 1);
    addLocalTracks(peer, remoteId);

    peer.onicecandidate = (event) => {
      if (event.candidate) sendMessage({ type: "ice_candidate", target_id: remoteId, payload: event.candidate.toJSON() });
    };
    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      logWebRTC(`Remote ${event.track.kind} track received from ${remoteId}`);
      storeRemoteStream(remoteId, stream);
    };
    peer.onconnectionstatechange = () => {
      logWebRTC(`peer=${remoteId} connectionState=${peer.connectionState}`);
      setPeerStatus(remoteId, peer.connectionState as PeerConnectionStatus);
      if (["failed", "closed", "disconnected"].includes(peer.connectionState)) removeRemoteStream(remoteId);
    };
    peer.oniceconnectionstatechange = () => {
      logWebRTC(`peer=${remoteId} iceConnectionState=${peer.iceConnectionState}`);
    };
    peer.onicegatheringstatechange = () => {
      logWebRTC(`peer=${remoteId} iceGatheringState=${peer.iceGatheringState}`);
    };
    peer.onsignalingstatechange = () => {
      logWebRTC(`peer=${remoteId} signalingState=${peer.signalingState}`);
    };

    setPeerStatus(remoteId, "new");
    peersRef.current.set(remoteId, peer);
    return peer;
  }, [addLocalTracks, removeRemoteStream, sendMessage, setPeerStatus, storeRemoteStream]);

  /**
   * Closes the peer connection for a participant and clears every trace of it
   * (peer, remote stream, pending ICE, offer bookkeeping, status). Safe to
   * call multiple times for the same participant.
   */
  const removePeerConnection = useCallback((remoteId: string) => {
    const peer = peersRef.current.get(remoteId);
    if (peer) {
      logWebRTC(`Closing peer connection: ${remoteId}`);
      try {
        peer.close();
      } catch (error) {
        logWebRTCError(`Failed to close peer connection for ${remoteId}`, error);
      }
    }
    peersRef.current.delete(remoteId);
    pendingIceRef.current.delete(remoteId);
    offersStartedRef.current.delete(remoteId);
    signalQueuesRef.current.delete(remoteId);
    removeRemoteStream(remoteId);
    setPeerStatuses((current) => {
      if (!(remoteId in current)) return current;
      const next = { ...current };
      delete next[remoteId];
      return next;
    });
  }, [removeRemoteStream]);

  /** Stops every screen track and clears the share state. Touches no peer and no camera track. */
  const stopScreenTracks = useCallback(() => {
    const stream = screenStreamRef.current;
    if (!stream) return;
    screenStreamRef.current = null;
    setScreenStream(null);
    // Deliberate stop: detach the browser-native-stop handler first so it
    // does not re-enter stopScreenShare for a share that is already ending.
    stream.getVideoTracks().forEach((track) => { track.onended = null; });
    stream.getTracks().forEach((track) => track.stop());
    logWebRTC("Screen tracks stopped");
  }, []);

  /**
   * Closes every peer connection and stops any active screen share (meeting
   * end, leave, unmount — a screen track with no senders left must not
   * outlive the peers). Local media cleanup is owned by useLocalMedia.
   */
  const closeAllPeerConnections = useCallback(() => {
    permanentlyClosedRef.current = true;
    stopScreenTracks();
    if (peersRef.current.size > 0) logWebRTC(`Closing all peer connections (${peersRef.current.size})`);
    peersRef.current.forEach((_, remoteId) => removePeerConnection(remoteId));
    peersRef.current.clear();
    remoteStreamsRef.current.clear();
    pendingIceRef.current.clear();
    offersStartedRef.current.clear();
    signalQueuesRef.current.clear();
    setRemoteStreams({});
    setPeerStatuses({});
  }, [removePeerConnection, stopScreenTracks]);

  /**
   * Swaps the outgoing video track on every active peer connection via
   * RTCRtpSender.replaceTrack(). This is the whole trick behind screen
   * sharing: the sender and its m-line stay exactly as negotiated, only the
   * media flowing through them changes — no new peer, no offer/answer, no
   * ICE. Failures are isolated per peer: one failing replaceTrack never
   * touches the others.
   */
  const replaceVideoTrackOnAllPeers = useCallback(async (track: MediaStreamTrack | null): Promise<{ replaced: number; failed: number }> => {
    let replaced = 0;
    let failed = 0;
    for (const [remoteId, peer] of Array.from(peersRef.current.entries())) {
      const sender = peer.getSenders().find((candidate) => candidate.track?.kind === "video");
      if (!sender) {
        logWebRTC(`No video sender on ${remoteId}; skipping track replacement`);
        continue;
      }
      try {
        await sender.replaceTrack(track);
        replaced += 1;
        logWebRTC(`Replaced outgoing video track on ${remoteId}`);
      } catch (error) {
        failed += 1;
        logWebRTCError(`Failed to replace video track on ${remoteId}`, error);
      }
    }
    return { replaced, failed };
  }, []);

  /**
   * Stops screen sharing: restores the camera track on every peer (with its
   * pre-share enabled state, which was never touched), stops the screen
   * tracks, and notifies the room.
   */
  const stopScreenShare = useCallback(() => {
    if (!screenStreamRef.current) return;
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] ?? null;
    replaceVideoTrackOnAllPeers(cameraTrack).then(({ replaced, failed }) => {
      logWebRTC(`Camera restored on ${replaced} peer(s)${failed ? `, ${failed} failed` : ""}`);
    });
    stopScreenTracks();
    sendMessage({ type: "screen_share_stopped" });
  }, [replaceVideoTrackOnAllPeers, sendMessage, stopScreenTracks]);

  /**
   * Starts screen sharing on top of the existing peer connections:
   * getDisplayMedia → replaceTrack(screenTrack) on every peer → notify the
   * room. The camera stream is left completely untouched so stopScreenShare
   * can restore exactly what was there before.
   */
  const startScreenShare = useCallback(async (): Promise<ScreenShareStartResult> => {
    if (screenStreamRef.current) return { ok: true };
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
      return { ok: false, code: "UNSUPPORTED", message: "This browser does not support screen sharing." };
    }
    let stream: MediaStream;
    try {
      // audio: false — system audio capture is deliberately not wired into the
      // microphone track in this phase.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (error) {
      const described = describeScreenShareError(error);
      logWebRTC(`getDisplayMedia failed: ${described.code}`);
      return { ok: false, ...described };
    }
    const screenTrack = stream.getVideoTracks()[0];
    if (!screenTrack) {
      stream.getTracks().forEach((track) => track.stop());
      return { ok: false, code: "NO_VIDEO_TRACK", message: "The selected screen did not provide a video track." };
    }
    // Defensive: if the browser returns audio tracks despite audio:false, stop
    // them — they must never replace or mix into the microphone.
    stream.getAudioTracks().forEach((track) => track.stop());

    screenStreamRef.current = stream;
    setScreenStream(stream);
    const { replaced, failed } = await replaceVideoTrackOnAllPeers(screenTrack);
    logWebRTC(`Screen sharing started (${replaced} peer(s) now sending screen${failed ? `, ${failed} failed` : ""})`);
    // The browser's own "Stop sharing" bar ends the track without our UI.
    screenTrack.onended = () => {
      logWebRTC("Screen track ended outside the app (browser stop bar)");
      stopScreenShare();
    };
    sendMessage({ type: "screen_share_started" });
    return { ok: true };
  }, [replaceVideoTrackOnAllPeers, sendMessage, stopScreenShare]);

  /**
   * Waits (bounded) for the local MediaStream. An offer created before the
   * local tracks exist produces an SDP with no m-lines (no ICE transports,
   * nothing ever connects), and an answer created without local tracks marks
   * every m-line recvonly, so this side's media is never sent. Negotiation
   * must therefore not run ahead of getUserMedia.
   */
  const waitForLocalStream = useCallback(async (timeoutMs = 10000): Promise<MediaStream | null> => {
    const start = Date.now();
    while (!localStreamRef.current && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return localStreamRef.current;
  }, []);

  const flushIce = useCallback(async (remoteId: string, peer: RTCPeerConnection) => {
    const pending = pendingIceRef.current.get(remoteId) || [];
    for (const candidate of pending) await peer.addIceCandidate(candidate);
    pendingIceRef.current.delete(remoteId);
  }, []);

  /** Deterministic offer tie-break: only the participant with the smaller ID offers. */
  const startOffer = useCallback(async (remoteId: string) => {
    if (participantId >= remoteId || offersStartedRef.current.has(remoteId)) return;
    const peer = getOrCreatePeerConnection(remoteId);
    if (!peer) return;
    offersStartedRef.current.add(remoteId);
    // Re-attach right before offering: the stream may have arrived after the
    // peer was created, and the offer must contain the local m-lines.
    addLocalTracks(peer, remoteId);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    sendMessage({ type: "offer", target_id: remoteId, payload: { type: offer.type, sdp: offer.sdp, nego: peerGenerationsRef.current.get(remoteId) } });
  }, [addLocalTracks, getOrCreatePeerConnection, participantId, sendMessage]);

  /**
   * Handles offer/answer/ice_candidate messages relayed by the signaling server.
   * Runs strictly sequentially per sender (see handleSignal): the offer path
   * awaits mid-negotiation (waitForLocalStream, flushIce), so two concurrent
   * invocations for one peer would corrupt the negotiation state machine.
   */
  const processSignal = useCallback(async (message: MeetingSocketMessage) => {
    const senderId = typeof message.sender_id === "string" ? message.sender_id : "";
    const payload = message.payload as RTCSessionDescriptionInit | RTCIceCandidateInit | undefined;
    if (!senderId || !payload) return;
    try {
      const peer = getOrCreatePeerConnection(senderId);
      if (!peer) return;

      if (message.type === "offer") {
        await peer.setRemoteDescription(payload as RTCSessionDescriptionInit);
        await waitForLocalStream();
        addLocalTracks(peer, senderId);
        await flushIce(senderId, peer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        // Echo the offer's negotiation generation so the offerer can tell an
        // answer to its CURRENT offer apart from one aimed at a peer it has
        // since torn down and recreated.
        const nego = (payload as { nego?: number }).nego;
        const answerPayload: { type: RTCSdpType; sdp?: string; nego?: number } = { type: answer.type, sdp: answer.sdp };
        if (nego !== undefined) answerPayload.nego = nego;
        sendMessage({ type: "answer", target_id: senderId, payload: answerPayload });
      } else if (message.type === "answer") {
        // An answer tagged with an older peer generation belongs to a peer
        // this side has already torn down (join churn); applying it would
        // pair the new local offer with a mismatched remote description and
        // hang ICE in "connecting" forever.
        const nego = (payload as { nego?: number }).nego;
        if (nego !== undefined && nego !== peerGenerationsRef.current.get(senderId)) {
          logWebRTC(`Ignoring answer from ${senderId} for peer generation ${nego} (current ${peerGenerationsRef.current.get(senderId)})`);
          return;
        }
        // An answer can arrive for an offer this peer has already answered
        // (duplicate offer churn while someone reconnects). Applying a second
        // answer to a stable peer throws InvalidStateError, so drop it.
        if (peer.signalingState !== "have-local-offer") {
          logWebRTC(`Ignoring stale answer from ${senderId} (signalingState=${peer.signalingState})`);
          return;
        }
        await peer.setRemoteDescription(payload as RTCSessionDescriptionInit);
        await flushIce(senderId, peer);
      } else if (message.type === "ice_candidate") {
        if (peer.remoteDescription) await peer.addIceCandidate(payload as RTCIceCandidateInit);
        else pendingIceRef.current.set(senderId, [...(pendingIceRef.current.get(senderId) || []), payload as RTCIceCandidateInit]);
      }
    } catch (error) {
      logWebRTCError(`Failed to process ${String(message.type)} signal from ${senderId}`, error);
    }
  }, [addLocalTracks, flushIce, getOrCreatePeerConnection, sendMessage, waitForLocalStream]);

  /**
   * Signal entry point: enqueues the message on the sender's FIFO so offer /
   * answer / ICE handling for one peer never runs concurrently. Signals for
   * different senders still run in parallel (they touch different peers).
   */
  const handleSignal = useCallback((message: MeetingSocketMessage) => {
    const senderId = typeof message.sender_id === "string" ? message.sender_id : "";
    if (!senderId || !message.payload) return;
    const previous = signalQueuesRef.current.get(senderId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => processSignal(message));
    signalQueuesRef.current.set(senderId, next);
  }, [processSignal]);

  // Presence sync: create a peer per new remote participant, remove peers for
  // participants that left. Presence comes from Phase 2 (room_state /
  // participant_joined / participant_left), keyed by the same participant IDs.
  // Offers are only started once the local stream exists (see waitForLocalStream);
  // the effect re-runs when the stream arrives and offers then.
  useEffect(() => {
    if (permanentlyClosedRef.current) {
      const stream = localStreamRef.current;
      const tracksStillLive = stream !== null && stream.getTracks().some((track) => track.readyState === "live");
      if (!tracksStillLive) return;
      permanentlyClosedRef.current = false;
    }
    const activeIds = new Set(participants.map((participant) => participant.participant_id).filter((id) => id !== participantId));
    participants.forEach((participant) => {
      if (participant.participant_id === participantId) return;
      const peer = getOrCreatePeerConnection(participant.participant_id);
      if (peer && localStream) startOffer(participant.participant_id).catch((error) => logWebRTCError(`Offer to ${participant.participant_id} failed`, error));
    });
    peersRef.current.forEach((_, remoteId) => {
      if (!activeIds.has(remoteId)) removePeerConnection(remoteId);
    });
  }, [getOrCreatePeerConnection, localStream, participantId, participants, removePeerConnection, startOffer]);

  // The local stream can arrive after peers were created (permissions are
  // slow); attach tracks to existing peers when it shows up.
  useEffect(() => {
    peersRef.current.forEach((peer, remoteId) => addLocalTracks(peer, remoteId));
  }, [localStream, addLocalTracks]);

  // Unmount: close all peers. Local media cleanup is owned by useLocalMedia.
  useEffect(() => () => {
    closeAllPeerConnections();
  }, [closeAllPeerConnections]);

  return {
    remoteStreams,
    peerStatuses,
    isSupported,
    getOrCreatePeerConnection,
    removePeerConnection,
    closeAllPeerConnections,
    handleSignal,
    // Screen sharing (built on replaceTrack over the existing peers).
    screenStream,
    isScreenSharing: screenStream !== null,
    startScreenShare,
    stopScreenShare,
  };
}
