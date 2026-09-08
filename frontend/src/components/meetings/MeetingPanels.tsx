"use client";

import { useEffect, useState } from "react";
import { CalendarPlus, Copy, Pencil, Play, RotateCcw } from "lucide-react";
import type { MeetingSummary } from "../../lib/types";
import { formatDuration, formatScheduleTime, invitationText, invitationUrl } from "../../lib/invite";

function StatusChip({ status }: { status: string }) {
  if (status === "active") return <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200/70 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Live</span>;
  if (status === "ended") return <span className="inline-flex items-center rounded-full bg-slate-100 border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-500">Ended</span>;
  return <span className="inline-flex items-center rounded-full bg-blue-50 border border-blue-200/70 px-2 py-0.5 text-[11px] font-medium text-blue-700">Upcoming</span>;
}

export function MeetingListItem({ meeting, selected, onSelect }: { meeting: MeetingSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-meeting-item={meeting.meeting_id}
      onClick={onSelect}
      aria-pressed={selected}
      className={`w-full text-left rounded-xl border p-3.5 transition-colors ${
        selected ? "border-blue-300 bg-blue-50/70 shadow-sm" : "border-slate-200/80 bg-white hover:border-slate-300 hover:bg-slate-50"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className={`text-sm leading-snug ${selected ? "font-semibold text-slate-900" : "font-medium text-slate-800"}`}>{meeting.title}</p>
        <StatusChip status={meeting.status} />
      </div>
      <p className="mt-1.5 text-xs text-slate-500">{formatScheduleTime(meeting.scheduled_at)}</p>
      <p className="mt-0.5 text-xs text-slate-400">ID: {meeting.meeting_id}</p>
    </button>
  );
}

export function MeetingList({ meetings, selectedId, onSelect }: { meetings: MeetingSummary[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<"upcoming" | "past">("upcoming");
  const upcoming = meetings.filter((meeting) => meeting.status !== "ended");
  const past = meetings.filter((meeting) => meeting.status === "ended");
  const visible = tab === "upcoming" ? upcoming : past;

  // If the current tab empties out (e.g. the selected meeting just ended),
  // fall back to the tab that still has content so the pane never goes blank.
  useEffect(() => {
    if (tab === "upcoming" && upcoming.length === 0 && past.length > 0) setTab("past");
  }, [tab, upcoming.length, past.length]);

  return (
    <div data-meeting-list className="rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.04)] flex flex-col overflow-hidden">
      <div className="p-2 border-b border-slate-100 grid grid-cols-2 gap-1" role="tablist" aria-label="Meeting lists">
        {(["upcoming", "past"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`rounded-lg py-2 text-sm transition-colors ${tab === value ? "bg-slate-900 text-white font-semibold" : "text-slate-500 font-medium hover:bg-slate-100"}`}
          >
            {value === "upcoming" ? "Upcoming" : "Past"}
          </button>
        ))}
      </div>
      <div className="p-3 flex flex-col gap-2 overflow-y-auto max-h-[calc(100dvh-16rem)] lg:max-h-[calc(100dvh-14rem)] min-h-[220px]">
        {visible.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-10 px-4">
            <div className="w-12 h-12 mb-3 rounded-2xl bg-[#edf3ff] text-[#2f6fed] flex items-center justify-center"><CalendarPlus className="w-5 h-5" /></div>
            <p className="text-sm font-semibold text-slate-900">{tab === "upcoming" ? "No upcoming meetings" : "No past meetings"}</p>
            <p className="mt-1 text-xs text-slate-500">{tab === "upcoming" ? "Schedule one and it will show up here." : "Meetings you have ended will be listed here."}</p>
          </div>
        ) : (
          visible.map((meeting) => (
            <MeetingListItem key={meeting.id} meeting={meeting} selected={meeting.id === selectedId} onSelect={() => onSelect(meeting.id)} />
          ))
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, onCopy }: { label: string; value: string; onCopy?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-slate-100 last:border-0">
      <span className="text-xs text-slate-500 shrink-0">{label}</span>
      <span className="text-sm text-slate-800 font-medium truncate min-w-0">{value}</span>
      {onCopy && (
        <button type="button" onClick={onCopy} className="w-8 h-8 -mr-2 rounded-lg text-slate-400 hover:text-[#2f6fed] hover:bg-blue-50 flex items-center justify-center shrink-0" aria-label={`Copy ${label}`}>
          <Copy className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export function MeetingDetails({
  meeting,
  hostName,
  canEdit,
  onStart,
  onStartAgain,
  onCopyInvitation,
  onEdit,
  onCopyValue,
}: {
  meeting: MeetingSummary;
  hostName: string;
  canEdit: boolean;
  onStart: () => void;
  onStartAgain: () => void;
  onCopyInvitation: () => void;
  onEdit: () => void;
  onCopyValue: (value: string, message: string) => void;
}) {
  const ended = meeting.status === "ended";
  return (
    <div data-meeting-details className="rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.04)] p-5 md:p-6 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-[-0.02em] text-slate-900 text-balance">{meeting.title}</h2>
          <div className="mt-2"><StatusChip status={meeting.status} /></div>
        </div>
      </div>

      <div>
        <DetailRow label="Meeting ID" value={meeting.meeting_id} onCopy={() => onCopyValue(meeting.meeting_id, "Meeting ID copied")} />
        <DetailRow label="Scheduled" value={formatScheduleTime(meeting.scheduled_at)} />
        <DetailRow label="Duration" value={formatDuration(meeting.duration_minutes)} />
        <DetailRow label="Host" value={hostName} />
        <DetailRow label="Invite link" value={`/room/${meeting.meeting_id}`} onCopy={() => onCopyValue(invitationUrl(meeting.meeting_id), "Invite link copied")} />
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {ended ? (
          <button type="button" onClick={onStartAgain} className="inline-flex items-center gap-2 rounded-xl bg-[#2f6fed] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#245dcc] transition-colors">
            <RotateCcw className="w-4 h-4" /> Start Again
          </button>
        ) : (
          <button type="button" onClick={onStart} className="inline-flex items-center gap-2 rounded-xl bg-[#2f6fed] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#245dcc] transition-colors">
            <Play className="w-4 h-4" /> Start
          </button>
        )}
        <button type="button" onClick={onCopyInvitation} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition-colors">
          <Copy className="w-4 h-4" /> Copy Invitation
        </button>
        {canEdit && !ended && (
          <button type="button" onClick={onEdit} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition-colors">
            <Pencil className="w-4 h-4" /> Edit
          </button>
        )}
      </div>
    </div>
  );
}

export function PersonalMeetingRoom({ personalMeetingId, onStart, onCopyInvitation }: { personalMeetingId: string | null; onStart: () => void; onCopyInvitation: () => void }) {
  const [showInvitation, setShowInvitation] = useState(false);
  return (
    <div data-pmi-card className="rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.04)] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-[-0.01em] text-slate-900">My Personal Meeting ID</h2>
          <p className="mt-1 text-xs text-slate-500">A permanent room — the link never changes.</p>
        </div>
        <p className="text-sm font-semibold tracking-[0.12em] text-slate-800 tabular-nums">{personalMeetingId ?? "----------"}</p>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <button type="button" onClick={onStart} className="inline-flex items-center gap-2 rounded-xl bg-[#2f6fed] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#245dcc] transition-colors">
          <Play className="w-4 h-4" /> Start
        </button>
        <button type="button" onClick={onCopyInvitation} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition-colors">
          <Copy className="w-4 h-4" /> Copy Invitation
        </button>
        <button type="button" onClick={() => setShowInvitation((current) => !current)} className="text-sm font-semibold text-[#2f6fed] hover:text-[#1749b5] transition-colors">
          {showInvitation ? "Hide Meeting Invitation" : "Show Meeting Invitation"}
        </button>
      </div>
      {showInvitation && (
        <pre className="mt-4 rounded-xl bg-slate-50 border border-slate-200 p-4 text-xs text-slate-700 whitespace-pre-wrap break-all">{invitationText(personalMeetingId ?? "", "My Personal Meeting Room")}</pre>
      )}
    </div>
  );
}
