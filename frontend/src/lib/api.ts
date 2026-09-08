"use client";

/**
 * The one place that knows where the backend lives. REST and WebSocket URLs
 * are derived from the same configuration here so they can never drift
 * between components:
 *
 *   NEXT_PUBLIC_API_URL  e.g. https://api.example.com   (REST base)
 *   NEXT_PUBLIC_WS_URL   e.g. wss://api.example.com     (WebSocket base)
 *
 * Production sets both; the dev defaults assume the backend runs beside the
 * frontend dev server on port 8000 over the page's own scheme.
 */

export const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/** WebSocket base — wss:// when the page is HTTPS, ws:// locally. */
export function wsBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return configured;
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:8000`;
}

/** Full meeting signaling socket URL. The only WS URL construction in the app. */
export function meetingSocketUrl(meetingId: string, participantId: string): string {
  return `${wsBaseUrl()}/api/ws/meetings/${encodeURIComponent(meetingId)}?participant_id=${encodeURIComponent(participantId)}`;
}
