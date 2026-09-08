"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type LocalMediaError = {
  code: string;
  message: string;
};

type UseLocalMediaOptions = {
  audioEnabled?: boolean;
  videoEnabled?: boolean;
  /**
   * Start requesting media as soon as the hook mounts. The room controller
   * passes false so it can defer getUserMedia until the meeting link is known
   * to be valid — an invalid or ended link must never touch the camera.
   */
  autoStart?: boolean;
};

function describeMediaError(error: unknown): LocalMediaError {
  const code = error instanceof DOMException ? error.name : "MEDIA_ERROR";
  const messages: Record<string, string> = {
    NotAllowedError: "Camera or microphone permission was denied.",
    NotFoundError: "No camera or microphone was found.",
    NotReadableError: "Your camera or microphone is unavailable or already in use.",
    OverconstrainedError: "Camera or microphone settings could not be satisfied.",
    SecurityError: "Browser security policy blocked camera or microphone access.",
  };
  return { code, message: messages[code] || "Camera or microphone could not be accessed." };
}

function logMedia(message: string) {
  if (process.env.NODE_ENV !== "production") console.info(`[MEDIA] ${message}`);
}

export function useLocalMedia({ audioEnabled = true, videoEnabled = true, autoStart = true }: UseLocalMediaOptions = {}) {
  const streamRef = useRef<MediaStream | null>(null);
  const initializationRef = useRef<Promise<MediaStream | null> | null>(null);
  const disposedRef = useRef(false);
  // Options are initial-only: the lobby and room share one stream across the
  // join transition (one getUserMedia per join), so a mid-session option change
  // must never restart media. startMedia keeps a stable identity accordingly.
  const initialOptionsRef = useRef({ audioEnabled, videoEnabled });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isAudioEnabled, setIsAudioEnabled] = useState(audioEnabled);
  const [isVideoEnabled, setIsVideoEnabled] = useState(videoEnabled);
  const [error, setError] = useState<LocalMediaError | null>(null);

  const syncTrackState = useCallback((media: MediaStream) => {
    const audioTrack = media.getAudioTracks()[0];
    const videoTrack = media.getVideoTracks()[0];
    setIsAudioEnabled(audioTrack ? audioTrack.enabled : false);
    setIsVideoEnabled(videoTrack ? videoTrack.enabled : false);
  }, []);

  const attachTrackListeners = useCallback((media: MediaStream) => {
    media.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", () => setIsAudioEnabled(false));
    });
    media.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => setIsVideoEnabled(false));
    });
  }, []);

  const stopMedia = useCallback(() => {
    if (!streamRef.current) return;
    logMedia("stopping tracks");
    streamRef.current.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    setIsAudioEnabled(false);
    setIsVideoEnabled(false);
    // The error described the acquisition attempt that produced the now
    // stopped stream; with no stream it is stale (a rejoin may succeed).
    setError(null);
  }, []);

  const startMedia = useCallback(async () => {
    if (streamRef.current) return streamRef.current;
    if (initializationRef.current) return initializationRef.current;
    if (!navigator.mediaDevices?.getUserMedia) {
      const mediaError = { code: "UNSUPPORTED", message: "This browser does not support camera or microphone access." };
      setError(mediaError);
      return null;
    }

    const request = (async () => {
      setError(null);
      logMedia("requesting camera/microphone");
      let media: MediaStream | null = null;
      let lastError: unknown = null;

      try {
        media = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (error) {
        lastError = error;
        logMedia("combined permission request was not available; trying devices independently");
        const tracks: MediaStreamTrack[] = [];
        try {
          const videoOnly = await navigator.mediaDevices.getUserMedia({ video: true });
          tracks.push(...videoOnly.getVideoTracks());
        } catch (error) {
          lastError = error;
        }
        try {
          const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true });
          tracks.push(...audioOnly.getAudioTracks());
        } catch (error) {
          lastError = error;
        }
        media = new MediaStream(tracks);
      }

      if (!media) {
        setError(describeMediaError(lastError));
        return null;
      }

      if (disposedRef.current) {
        media.getTracks().forEach((track) => track.stop());
        return null;
      }

      media.getAudioTracks().forEach((track) => { track.enabled = initialOptionsRef.current.audioEnabled; });
      media.getVideoTracks().forEach((track) => { track.enabled = initialOptionsRef.current.videoEnabled; });
      streamRef.current = media;
      setStream(media);
      syncTrackState(media);
      attachTrackListeners(media);
      if (!media.getAudioTracks().length || !media.getVideoTracks().length) {
        setError({ code: "PARTIAL_PERMISSION", message: "Some media devices were unavailable. You can continue with the available devices." });
      }
      logMedia(`stream acquired audio=${media.getAudioTracks().length > 0} video=${media.getVideoTracks().length > 0}`);
      return media;
    })();
    initializationRef.current = request;
    request.then(() => {
      if (initializationRef.current === request) initializationRef.current = null;
    }, () => {
      if (initializationRef.current === request) initializationRef.current = null;
    });
    return request;
  }, [syncTrackState, attachTrackListeners]);

  const setAudioEnabled = useCallback((enabled: boolean) => {
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) {
      setIsAudioEnabled(false);
      setError({ code: "NO_MICROPHONE", message: "No microphone was found." });
      return false;
    }
    track.enabled = enabled;
    setIsAudioEnabled(track.enabled);
    logMedia(`microphone ${track.enabled ? "enabled" : "disabled"}`);
    return track.enabled;
  }, []);

  const setVideoEnabled = useCallback((enabled: boolean) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) {
      setIsVideoEnabled(false);
      setError({ code: "NO_CAMERA", message: "No camera was found." });
      return false;
    }
    track.enabled = enabled;
    setIsVideoEnabled(track.enabled);
    logMedia(`camera ${track.enabled ? "enabled" : "disabled"}`);
    return track.enabled;
  }, []);

  const toggleAudio = useCallback(() => setAudioEnabled(!streamRef.current?.getAudioTracks()[0]?.enabled), [setAudioEnabled]);
  const toggleVideo = useCallback(() => setVideoEnabled(!streamRef.current?.getVideoTracks()[0]?.enabled), [setVideoEnabled]);

  useEffect(() => {
    disposedRef.current = false;
    if (autoStart) startMedia();
    return () => {
      disposedRef.current = true;
      stopMedia();
    };
    // autoStart is a per-call-site constant; startMedia/stopMedia are stable.
  }, [autoStart, startMedia, stopMedia]);

  return {
    stream,
    streamRef,
    isAudioEnabled,
    isVideoEnabled,
    toggleAudio,
    toggleVideo,
    setAudioEnabled,
    setVideoEnabled,
    startMedia,
    stopMedia,
    error,
  };
}
