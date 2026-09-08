"use client";

import { useState } from "react";
import { Field, Modal } from "../ui";
import { createMeeting } from "../../lib/meetings";
import { ensureIdentity, type UserIdentity } from "../../lib/identity";
import type { MeetingSummary } from "../../lib/types";

const DURATIONS = [
  ["15", "15 minutes"],
  ["30", "30 minutes"],
  ["45", "45 minutes"],
  ["60", "1 hour"],
  ["120", "2 hours"],
] as const;

/**
 * Schedules a meeting (topic, date, time, duration). Shared by the dashboard
 * quick action and the Meetings page so both create identical meetings.
 */
export function ScheduleMeetingModal({
  identity,
  onClose,
  onCreated,
}: {
  identity: UserIdentity | null;
  onClose: () => void;
  onCreated: (meeting: MeetingSummary) => void;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState("60");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const user = identity || (await ensureIdentity());
      const scheduledAt = date && time ? new Date(`${date}T${time}`).toISOString() : null;
      const meeting = await createMeeting({
        title: title.trim(),
        host_id: user.id,
        scheduled_at: scheduledAt,
        duration_minutes: parseInt(duration) || 60,
      });
      onCreated(meeting);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to schedule meeting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Schedule a meeting" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Meeting topic">
          <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Product review" maxLength={120} className="field" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="field" />
          </Field>
          <Field label="Time">
            <input type="time" value={time} onChange={(event) => setTime(event.target.value)} className="field" />
          </Field>
        </div>
        <Field label="Duration">
          <select value={duration} onChange={(event) => setDuration(event.target.value)} className="field bg-white">
            {DURATIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3 pt-2">
          <button type="button" onClick={onClose} className="secondary-button flex-1">Cancel</button>
          <button type="submit" disabled={saving} className="primary-button flex-1">{saving ? "Saving…" : "Save meeting"}</button>
        </div>
      </form>
    </Modal>
  );
}
