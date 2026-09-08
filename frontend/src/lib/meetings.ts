"use client";

import { apiUrl } from "./identity";
import type { MeetingSummary } from "./types";

/**
 * Shared REST helpers for meetings. One place builds the request payloads —
 * pages never hand-roll fetch bodies, so the join/create/edit flows cannot
 * drift between the dashboard and the meetings page.
 */

async function requestError(response: Response): Promise<Error> {
  // Surface the backend's human-readable detail when it has one; the fallback
  // is generic on purpose — no stack traces or raw payloads in the UI.
  let message = "Something went wrong. Please try again.";
  try {
    const body = await response.json();
    if (body?.detail) message = String(body.detail);
  } catch {
    /* not JSON — keep the generic message */
  }
  return new Error(message);
}

export async function fetchMeetings(): Promise<MeetingSummary[]> {
  const response = await fetch(`${apiUrl}/api/meetings`);
  if (!response.ok) throw await requestError(response);
  return response.json();
}

export interface CreateMeetingInput {
  title: string;
  host_id: string;
  description?: string | null;
  scheduled_at?: string | null;
  duration_minutes?: number | null;
}

export async function createMeeting(input: CreateMeetingInput): Promise<MeetingSummary> {
  const response = await fetch(`${apiUrl}/api/meetings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await requestError(response);
  return response.json();
}

export interface UpdateMeetingInput {
  title?: string;
  description?: string | null;
  scheduled_at?: string | null;
  duration_minutes?: number;
}

/** Host-only partial update; the backend rejects edits from anyone else. */
export async function updateMeeting(meetingId: string, requesterId: string, changes: UpdateMeetingInput): Promise<MeetingSummary> {
  const response = await fetch(`${apiUrl}/api/meetings/${meetingId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requester_id: requesterId, ...changes }),
  });
  if (!response.ok) throw await requestError(response);
  return response.json();
}

/** Starts (or reuses) the user's permanent personal meeting room. */
export async function startPersonalMeeting(userId: string): Promise<MeetingSummary> {
  const response = await fetch(`${apiUrl}/api/users/${userId}/personal-meeting`, { method: "POST" });
  if (!response.ok) throw await requestError(response);
  return response.json();
}

/** Registers the browser's user as a participant and returns the participant id. */
export async function joinAsParticipant(meetingId: string, displayName: string, userId: string): Promise<string> {
  const response = await fetch(`${apiUrl}/api/meetings/${meetingId}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ display_name: displayName, user_id: userId }),
  });
  if (!response.ok) throw await requestError(response);
  const participant = await response.json();
  return participant.id as string;
}
