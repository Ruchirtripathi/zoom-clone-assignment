"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Video } from "lucide-react";
import { MeetingDetails, MeetingList, PersonalMeetingRoom } from "../../../components/meetings/MeetingPanels";
import { ScheduleMeetingModal } from "../../../components/meetings/ScheduleMeetingModal";
import { EditMeetingModal } from "../../../components/meetings/EditMeetingModal";
import { apiUrl, ensureIdentity, type UserIdentity } from "../../../lib/identity";
import { invitationText } from "../../../lib/invite";
import { createMeeting, fetchMeetings, startPersonalMeeting } from "../../../lib/meetings";
import type { MeetingSummary } from "../../../lib/types";

/**
 * Zoom-style Meetings page: a list/detail split. The left column lists
 * upcoming and past meetings; the right shows the selected meeting's
 * details (plus the permanent Personal Meeting Room card). Every Start
 * button routes to the bare room link — the shared lobby handles name and
 * devices, so a meeting ID alone is always enough to join.
 */
export default function MeetingsPage() {
  const router = useRouter();
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<UserIdentity | null>(null);
  const [hostNames, setHostNames] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [isScheduleOpen, setIsScheduleOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await fetchMeetings();
      setMeetings(list);
      setLoadFailed(false);
    } catch (error) {
      console.error("Failed to load meetings:", error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    ensureIdentity().then(setIdentity).catch((error) => console.error("Failed to register identity:", error));
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  const upcoming = meetings.filter((meeting) => meeting.status !== "ended");
  const past = meetings.filter((meeting) => meeting.status === "ended");
  // Selection never dangles: an explicit pick wins while it exists, then it
  // falls back to the first upcoming (or past) meeting.
  const selected = meetings.find((meeting) => meeting.id === selectedId) ?? upcoming[0] ?? past[0] ?? null;
  const canEdit = Boolean(identity && selected && identity.id === selected.host_id);

  // Resolve the selected meeting's host name on demand — meetings created by
  // other browsers (guests scheduling, other test users) still show a real
  // name, without fetching every host in the (possibly long) list.
  useEffect(() => {
    if (!selected) return;
    const hostId = selected.host_id;
    if (hostNames[hostId] !== undefined) return;
    let cancelled = false;
    fetch(`${apiUrl}/api/users/${hostId}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((user) => {
        if (!cancelled && user?.display_name) setHostNames((previous) => ({ ...previous, [hostId]: user.display_name }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selected, hostNames]);

  const copyToClipboard = (text: string, message: string) => {
    navigator.clipboard.writeText(text).then(() => setToast(message));
  };

  // Start: the bare room link — the lobby collects the name and device
  // choices, then joins. Works identically for hosts and guests.
  const handleStart = () => {
    if (selected) router.push(`/room/${selected.meeting_id}`);
  };

  // An ended meeting cannot be restarted, so Start Again creates a fresh
  // instant meeting with the same topic and opens its join flow.
  const handleStartAgain = async () => {
    if (!selected || !identity) return;
    try {
      const meeting = await createMeeting({ title: selected.title, host_id: identity.id });
      router.push(`/room/${meeting.meeting_id}`);
    } catch (error) {
      console.error("Failed to start meeting again:", error);
      setToast("Unable to start a new meeting.");
    }
  };

  const handleStartPersonal = async () => {
    if (!identity) return;
    try {
      const meeting = await startPersonalMeeting(identity.id);
      router.push(`/room/${meeting.meeting_id}`);
    } catch (error) {
      console.error("Failed to start personal meeting:", error);
      setToast("Unable to start your Personal Meeting Room.");
    }
  };

  const handleNewInstantMeeting = async () => {
    if (!identity) return;
    try {
      const meeting = await createMeeting({ title: "Instant Meeting", host_id: identity.id });
      router.push(`/room/${meeting.meeting_id}`);
    } catch (error) {
      console.error("Failed to create meeting:", error);
      setToast("Unable to create a meeting.");
    }
  };

  return (
    <div className="max-w-[1240px] mx-auto flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-[-0.03em] text-slate-950">Meetings</h1>
          <p className="mt-1.5 text-sm text-slate-500">Your upcoming schedule and meeting history.</p>
        </div>
        <button
          type="button"
          onClick={() => setIsScheduleOpen(true)}
          className="inline-flex items-center gap-2 rounded-xl bg-[#2f6fed] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#245dcc] transition-colors"
        >
          <CalendarPlus className="w-4 h-4" /> Schedule a meeting
        </button>
      </header>

      {loading ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-10 flex items-center justify-center text-sm text-slate-500">Loading your meetings…</div>
      ) : loadFailed ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-10 flex flex-col items-center text-center gap-3">
          <p className="text-sm font-semibold text-slate-900">Unable to load your meetings</p>
          <p className="text-sm text-slate-500">Check your connection and try again.</p>
          <button type="button" onClick={() => { setLoading(true); void load(); }} className="secondary-button">Try again</button>
        </div>
      ) : (
        <div className="flex flex-col lg:flex-row gap-5 items-stretch">
          <div className="w-full lg:w-[380px] shrink-0">
            <MeetingList meetings={meetings} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-5">
            {selected ? (
              <MeetingDetails
                meeting={selected}
                hostName={hostNames[selected.host_id] || "—"}
                canEdit={canEdit}
                onStart={handleStart}
                onStartAgain={handleStartAgain}
                onCopyInvitation={() => copyToClipboard(invitationText(selected.meeting_id, selected.title), "Invitation copied")}
                onEdit={() => setIsEditOpen(true)}
                onCopyValue={copyToClipboard}
              />
            ) : (
              <div className="rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.04)] p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
                <div className="w-14 h-14 mb-4 rounded-2xl bg-[#edf3ff] text-[#2f6fed] flex items-center justify-center"><Video className="w-6 h-6" /></div>
                <p className="text-slate-900 font-semibold">Nothing scheduled yet</p>
                <p className="text-slate-500 text-sm mt-1 max-w-[280px]">Pick a time that works, or start an instant meeting right away.</p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
                  <button type="button" onClick={() => setIsScheduleOpen(true)} className="inline-flex items-center gap-2 rounded-xl bg-[#2f6fed] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#245dcc] transition-colors">
                    <CalendarPlus className="w-4 h-4" /> Schedule a meeting
                  </button>
                  <button type="button" onClick={handleNewInstantMeeting} className="secondary-button">New meeting</button>
                </div>
              </div>
            )}
            <PersonalMeetingRoom
              personalMeetingId={identity?.personal_meeting_id ?? null}
              onStart={handleStartPersonal}
              onCopyInvitation={() => identity && copyToClipboard(invitationText(identity.personal_meeting_id, "My Personal Meeting Room"), "Invitation copied")}
            />
          </div>
        </div>
      )}

      {isScheduleOpen && (
        <ScheduleMeetingModal
          identity={identity}
          onClose={() => setIsScheduleOpen(false)}
          onCreated={(meeting) => {
            setIsScheduleOpen(false);
            setSelectedId(meeting.id);
            setToast("Meeting scheduled");
            void load();
          }}
        />
      )}
      {isEditOpen && selected && identity && (
        <EditMeetingModal
          meeting={selected}
          requesterId={identity.id}
          onClose={() => setIsEditOpen(false)}
          onSaved={(updated) => {
            setMeetings((previous) => previous.map((meeting) => (meeting.id === updated.id ? updated : meeting)));
            setIsEditOpen(false);
            setToast("Meeting updated");
          }}
        />
      )}
      {toast && <div role="status" className="fixed bottom-20 md:bottom-8 left-1/2 -translate-x-1/2 z-[85] rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm font-medium shadow-2xl">{toast}</div>}
    </div>
  );
}
