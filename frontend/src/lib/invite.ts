"use client";

/**
 * Invite links are always the bare room URL — meeting ID only. Participant,
 * user and session identifiers never appear in a link: identity is
 * established when someone actually joins, not when they receive a link.
 */
export function invitationUrl(meetingId: string): string {
  return typeof window !== "undefined" ? `${window.location.origin}/room/${meetingId}` : `/room/${meetingId}`;
}

/** Groups the numeric meeting ID the way conferencing products read it aloud. */
export function formatMeetingId(meetingId: string): string {
  return (meetingId.match(/.{1,3}/g) || [meetingId]).join(" ");
}

/**
 * The clipboard payload for "Copy Invitation". Deliberately minimal: the
 * join URL and the Meeting ID — everything a guest needs, nothing about the
 * host's session, participant records or internal database IDs.
 */
export function invitationText(meetingId: string, title?: string | null): string {
  const lines = ["Join my meeting:", invitationUrl(meetingId), "", `Meeting ID: ${formatMeetingId(meetingId)}`];
  if (title) lines.unshift(`${title}`);
  return lines.join("\n");
}

/**
 * The API returns UTC datetimes without a timezone marker (SQLite stores
 * naive UTC), but `new Date()` parses those as LOCAL time — which shifts
 * every schedule by the viewer's offset. Anchor them to UTC before parsing.
 */
export function parseBackendDate(value: string): Date {
  return new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
}

export function formatScheduleTime(value: string | null | undefined): string {
  if (!value) return "Instant meeting";
  return parseBackendDate(value).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes) return "Open";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}
