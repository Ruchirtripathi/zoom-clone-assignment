"use client";

/**
 * The meeting fields the frontend consumes (a subset of the backend's
 * MeetingResponse). Internal database ids (`id`) never render in the UI and
 * never appear in links — the public `meeting_id` is the only identifier a
 * user ever sees.
 */
export interface MeetingSummary {
  id: string;
  meeting_id: string;
  title: string;
  description?: string | null;
  scheduled_at: string | null;
  duration_minutes: number | null;
  status: string;
  host_id: string;
  ended_at?: string | null;
}
