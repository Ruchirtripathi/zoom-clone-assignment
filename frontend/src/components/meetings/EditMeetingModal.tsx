"use client";

import { useState } from "react";
import { Field, Modal } from "../ui";
import { updateMeeting } from "../../lib/meetings";
import { parseBackendDate } from "../../lib/invite";
import type { MeetingSummary } from "../../lib/types";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Edits a meeting's safe fields — title, description, schedule, duration.
 * Host reassignment and status are not editable here (nor anywhere): the
 * backend rejects them, and the UI never offers them.
 */
export function EditMeetingModal({
  meeting,
  requesterId,
  onClose,
  onSaved,
}: {
  meeting: MeetingSummary;
  requesterId: string;
  onClose: () => void;
  onSaved: (meeting: MeetingSummary) => void;
}) {
  const scheduled = meeting.scheduled_at ? parseBackendDate(meeting.scheduled_at) : null;
  const [title, setTitle] = useState(meeting.title);
  const [description, setDescription] = useState(meeting.description || "");
  const [date, setDate] = useState(scheduled ? `${scheduled.getFullYear()}-${pad(scheduled.getMonth() + 1)}-${pad(scheduled.getDate())}` : "");
  const [time, setTime] = useState(scheduled ? `${pad(scheduled.getHours())}:${pad(scheduled.getMinutes())}` : "");
  const [duration, setDuration] = useState(String(meeting.duration_minutes || 60));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateMeeting(meeting.meeting_id, requesterId, {
        title: title.trim(),
        description: description.trim() || null,
        scheduled_at: date && time ? new Date(`${date}T${time}`).toISOString() : null,
        duration_minutes: parseInt(duration) || 60,
      });
      onSaved(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit meeting" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Meeting topic">
          <input required value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} className="field" />
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={2000} placeholder="What is this meeting about?" className="field resize-none" />
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
            {[["15", "15 minutes"], ["30", "30 minutes"], ["45", "45 minutes"], ["60", "1 hour"], ["120", "2 hours"]].map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3 pt-2">
          <button type="button" onClick={onClose} className="secondary-button flex-1">Cancel</button>
          <button type="submit" disabled={saving} className="primary-button flex-1">{saving ? "Saving…" : "Save changes"}</button>
        </div>
      </form>
    </Modal>
  );
}
