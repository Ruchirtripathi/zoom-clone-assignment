"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { meetingSocketUrl } from "../lib/api";

export type MeetingSocketStatus = "connecting" | "connected" | "reconnecting" | "disconnected";
export type MeetingSocketMessage = Record<string, unknown>;

type UseMeetingSocketOptions = {
  meetingId: string;
  participantId: string;
  onMessage?: (message: MeetingSocketMessage) => void;
};

const reconnectDelays = [500, 1000, 2000, 4000, 8000];

export function useMeetingSocket({ meetingId, participantId, onMessage }: UseMeetingSocketOptions) {
  const socketRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  const [status, setStatus] = useState<MeetingSocketStatus>("disconnected");

  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!meetingId || !participantId) {
      setStatus("disconnected");
      return;
    }

    // Everything below is local to THIS effect run. A stale socket from a
    // previous run (StrictMode remount, fast participantId change) must never
    // influence the new connection: its late "close" event used to leak past
    // a shared "intentionallyClosed" flag, trigger a spurious reconnect, and
    // get rejected by the server as a duplicate participant (4008), which
    // left the hook holding a dead socket while sends silently failed.
    let disposed = false;
    let activeSocket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    let duplicateRetries = 0;

    const detachHandlers = (socket: WebSocket) => {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
    };

    const connect = () => {
      if (disposed) return;
      if (activeSocket) {
        // Abandon the previous attempt silently so its events cannot
        // trigger another reconnect cycle.
        detachHandlers(activeSocket);
        activeSocket.close(1000, "Replaced by a new connection attempt");
        activeSocket = null;
      }

      setStatus(retryCount === 0 ? "connecting" : "reconnecting");
      const socket = new WebSocket(meetingSocketUrl(meetingId, participantId));
      activeSocket = socket;
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed || activeSocket !== socket) return;
        retryCount = 0;
        duplicateRetries = 0;
        setStatus("connected");
      };

      socket.onmessage = (event) => {
        if (disposed || activeSocket !== socket) return;
        try {
          const message = JSON.parse(event.data) as MeetingSocketMessage;
          onMessageRef.current?.(message);
        } catch {
          onMessageRef.current?.({
            type: "error",
            code: "INVALID_MESSAGE",
            message: "Received an invalid WebSocket message.",
          });
        }
      };

      socket.onerror = () => {
        if (disposed || activeSocket !== socket) return;
        setStatus("disconnected");
      };

      socket.onclose = (event) => {
        if (disposed || activeSocket !== socket) return;
        if (event.code === 1008) {
          // Rejected membership (removed participant). Terminal — do not retry.
          setStatus("disconnected");
          return;
        }
        if (event.code === 4008) {
          // A duplicate usually means THIS participant's previous socket has
          // not finished unregistering yet (a StrictMode remount or a fast
          // refresh). Give the server a moment and try again — but only a
          // couple of times, so a genuine second tab still ends up
          // disconnected instead of retrying forever.
          if (duplicateRetries < 2) {
            duplicateRetries += 1;
            setStatus("reconnecting");
            reconnectTimer = setTimeout(connect, 1000);
            return;
          }
          setStatus("disconnected");
          return;
        }
        setStatus("reconnecting");
        const delay = reconnectDelays[Math.min(retryCount, reconnectDelays.length - 1)];
        retryCount += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (activeSocket) {
        detachHandlers(activeSocket);
        activeSocket.close(1000, "Meeting room unmounted");
      }
      socketRef.current = null;
      setStatus("disconnected");
    };
  }, [meetingId, participantId]);

  const sendMessage = useCallback((message: MeetingSocketMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  return { status, sendMessage };
}
