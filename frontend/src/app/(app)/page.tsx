"use client";

import { ArrowUpRight, Calendar, Clock3, Copy, MoreHorizontal, Plus, Sparkles, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Field } from "../../components/ui";
import { ScheduleMeetingModal } from "../../components/meetings/ScheduleMeetingModal";
import { ensureIdentity, type UserIdentity } from "../../lib/identity";
import { invitationUrl, parseBackendDate } from "../../lib/invite";
import { createMeeting, fetchMeetings, joinAsParticipant, startPersonalMeeting } from "../../lib/meetings";
import type { MeetingSummary } from "../../lib/types";

export default function Home() {
  const router = useRouter();
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [isJoinOpen, setIsJoinOpen] = useState(false);
  const [isScheduleOpen, setIsScheduleOpen] = useState(false);
  const [joinMeetingId, setJoinMeetingId] = useState("");
  const [now, setNow] = useState<Date | null>(null);
  const [identity, setIdentity] = useState<UserIdentity | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setNow(new Date());
    ensureIdentity().then(setIdentity).catch((error) => console.error("Failed to register identity:", error));
    void loadMeetings();
    const timer = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  const loadMeetings = async () => {
    try {
      setMeetings(await fetchMeetings());
    } catch (error) {
      console.error("Failed to fetch meetings:", error);
    }
  };

  // Instant meeting: the host joins straight in (their identity is already
  // established here) — everyone else enters through the room lobby.
  const handleNewMeeting = async () => {
    try {
      const user = identity || await ensureIdentity();
      const meeting = await createMeeting({ title: "Instant Meeting", host_id: user.id });
      const participantId = await joinAsParticipant(meeting.meeting_id, user.display_name, user.id);
      router.push(`/room/${meeting.meeting_id}?participant_id=${participantId}&name=${encodeURIComponent(user.display_name)}`);
    } catch (error) {
      console.error("Failed to start new meeting:", error);
      setToast("Unable to start a new meeting.");
    }
  };

  const handlePersonalMeeting = async () => {
    try {
      const user = identity || await ensureIdentity();
      const meeting = await startPersonalMeeting(user.id);
      const participantId = await joinAsParticipant(meeting.meeting_id, user.display_name, user.id);
      router.push(`/room/${meeting.meeting_id}?participant_id=${participantId}&name=${encodeURIComponent(user.display_name)}`);
    } catch (error) {
      console.error("Failed to start personal meeting:", error);
      setToast("Unable to start your Personal Meeting Room.");
    }
  };

  // Join by Meeting ID: the bare room link opens the shared lobby, where the
  // name is entered and devices are chosen. A bad ID resolves to the
  // "Meeting not found" screen — never a raw error.
  const handleJoinMeeting = (event: React.FormEvent) => {
    event.preventDefault();
    const id = joinMeetingId.trim();
    if (!id) return;
    router.push(`/room/${encodeURIComponent(id)}`);
  };

  const time = now ? now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "--:--";
  const date = now ? now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "Your local time zone";
  const todayLabel = now ? now.toLocaleDateString([], { month: "short", day: "numeric" }) : "today";

  return (
    <div className="max-w-[1240px] mx-auto flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-[#2f6fed] mb-2">Monday workspace</p>
          <h1 className="text-3xl md:text-[42px] leading-tight font-semibold tracking-[-0.045em] text-slate-950">Good evening</h1>
          <p className="mt-2 text-sm md:text-base text-slate-500">Your meetings, messages, and focus time in one place.</p>
          <div className="mt-4 flex items-center gap-3 text-xs text-slate-500"><span>Personal Meeting ID</span><strong className="text-slate-800 tracking-[0.12em]">{identity?.personal_meeting_id || "----------"}</strong><button onClick={() => identity && navigator.clipboard.writeText(identity.personal_meeting_id)} className="text-[#2f6fed] font-semibold hover:text-[#1749b5]">Copy</button><button onClick={handlePersonalMeeting} className="text-[#2f6fed] font-semibold hover:text-[#1749b5]">Open personal room</button></div>
        </div>
        <div className="hidden sm:flex items-center gap-3">
          <button className="w-10 h-10 rounded-full bg-white border border-slate-200 text-slate-500 flex items-center justify-center hover:text-slate-900 hover:border-slate-300 transition-colors" aria-label="View activity"><Clock3 className="w-[18px] h-[18px]" /></button>
          <div className="w-10 h-10 rounded-full bg-[#b96e3d] text-white flex items-center justify-center text-sm font-semibold">RT</div>
        </div>
      </header>

      <section className="grid lg:grid-cols-[1.45fr_0.55fr] gap-5">
        <div className="rounded-2xl bg-[#1d2738] text-white p-6 md:p-8 min-h-[220px] relative overflow-hidden flex flex-col justify-between shadow-[0_16px_40px_rgba(29,39,56,0.14)]">
          <div className="relative z-10 flex items-start justify-between gap-5">
            <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-200">Today</p><p className="mt-5 text-5xl md:text-6xl font-semibold tracking-[-0.07em]">{time}</p><p className="mt-2 text-sm text-slate-300">{date}</p></div>
            <div className="hidden sm:flex w-11 h-11 rounded-xl bg-white/10 items-center justify-center"><Sparkles className="w-5 h-5 text-amber-300" /></div>
          </div>
          <div className="relative z-10 flex items-center gap-2 text-xs text-slate-300"><span className="w-2 h-2 rounded-full bg-emerald-400" /> All systems operational</div>
          <div className="absolute -right-16 -bottom-28 w-72 h-72 rounded-full border-[28px] border-white/5" />
          <div className="absolute right-14 -bottom-32 w-64 h-64 rounded-full border-[18px] border-blue-400/10" />
        </div>
        <div className="rounded-2xl bg-white border border-slate-200/80 p-6 flex flex-col justify-between shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
          <div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-700">Quick start</p><MoreHorizontal className="w-5 h-5 text-slate-400" /></div>
          <div className="grid grid-cols-3 gap-2 mt-7">
            <button onClick={handleNewMeeting} className="group flex flex-col items-center gap-2 text-center"><span className="w-12 h-12 rounded-xl bg-[#f37b3d] text-white flex items-center justify-center shadow-md shadow-orange-500/20 group-hover:-translate-y-0.5 transition-transform"><Video className="w-5 h-5" /></span><span className="text-xs font-medium text-slate-600">New meeting</span></button>
            <button onClick={() => setIsJoinOpen(true)} className="group flex flex-col items-center gap-2 text-center"><span className="w-12 h-12 rounded-xl bg-[#2f6fed] text-white flex items-center justify-center shadow-md shadow-blue-500/20 group-hover:-translate-y-0.5 transition-transform"><Plus className="w-5 h-5" /></span><span className="text-xs font-medium text-slate-600">Join</span></button>
            <button onClick={() => setIsScheduleOpen(true)} className="group flex flex-col items-center gap-2 text-center"><span className="w-12 h-12 rounded-xl bg-[#e8efff] text-[#2f6fed] flex items-center justify-center group-hover:-translate-y-0.5 transition-transform"><Calendar className="w-5 h-5" /></span><span className="text-xs font-medium text-slate-600">Schedule</span></button>
          </div>
        </div>
      </section>

      <section id="meetings" className="bg-white rounded-2xl border border-slate-200/80 shadow-[0_8px_24px_rgba(15,23,42,0.04)] flex flex-col">
        <div className="p-5 md:p-6 border-b border-slate-100 flex items-center justify-between gap-4"><div><h2 className="text-lg font-semibold tracking-[-0.02em] text-slate-900">Upcoming meetings</h2><p className="text-sm text-slate-500 mt-1">Your schedule for {todayLabel}</p></div><Linkish href="/meetings" label="View calendar" /></div>
        {meetings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center min-h-[260px]"><div className="w-14 h-14 mb-4 rounded-2xl bg-[#edf3ff] text-[#2f6fed] flex items-center justify-center"><Calendar className="w-6 h-6" /></div><p className="text-slate-900 font-semibold">Your calendar is clear</p><p className="text-slate-500 text-sm mt-1">Create a meeting when you are ready to connect.</p></div>
        ) : (
          <div className="divide-y divide-slate-100">{meetings.map((meeting) => (
            <div key={meeting.id} className="p-5 md:px-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/70 transition-colors">
              <div className="flex items-start gap-3"><div className="w-10 h-10 rounded-xl bg-[#edf3ff] text-[#2f6fed] flex items-center justify-center shrink-0"><Video className="w-[18px] h-[18px]" /></div><div><h3 className="font-semibold text-[15px] text-slate-900">{meeting.title}</h3><p className="text-sm text-slate-500 mt-1">{meeting.scheduled_at ? parseBackendDate(meeting.scheduled_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "Instant meeting"}</p></div></div>
              <div className="flex items-center gap-3 sm:justify-end"><span className="hidden md:block text-xs text-slate-400">{meeting.duration_minutes ? `${meeting.duration_minutes} min` : "Open"}</span><button onClick={() => { navigator.clipboard.writeText(invitationUrl(meeting.meeting_id)).then(() => setToast("Invite link copied")); }} className="w-9 h-9 rounded-lg border border-slate-200 text-slate-500 hover:text-[#2f6fed] hover:border-blue-200 flex items-center justify-center transition-colors" aria-label="Copy invite link"><Copy className="w-4 h-4" /></button><button onClick={() => router.push(`/room/${meeting.meeting_id}`)} className="w-9 h-9 rounded-lg bg-[#2f6fed] text-white hover:bg-[#245dcc] flex items-center justify-center transition-colors" aria-label="Open meeting"><ArrowUpRight className="w-4 h-4" /></button></div>
            </div>
          ))}</div>
        )}
      </section>

      {isJoinOpen && <Modal title="Join a meeting" onClose={() => setIsJoinOpen(false)}><form onSubmit={handleJoinMeeting} className="space-y-4"><Field label="Meeting ID"><input required value={joinMeetingId} onChange={(event) => setJoinMeetingId(event.target.value)} placeholder="Enter the meeting ID" inputMode="numeric" className="field" /></Field><p className="text-xs text-slate-500 -mt-1">You will enter your name and choose your microphone and camera before joining.</p><button className="primary-button w-full" type="submit">Continue</button></form></Modal>}
      {isScheduleOpen && <ScheduleMeetingModal identity={identity} onClose={() => setIsScheduleOpen(false)} onCreated={() => { setIsScheduleOpen(false); setToast("Meeting scheduled"); void loadMeetings(); }} />}
      {toast && <div role="status" className="fixed bottom-20 md:bottom-8 left-1/2 -translate-x-1/2 z-[85] rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm font-medium shadow-2xl">{toast}</div>}
    </div>
  );
}

function Linkish({ href, label }: { href: string; label: string }) {
  return <a href={href} className="hidden sm:flex items-center gap-2 text-sm font-semibold text-[#2f6fed] hover:text-[#1749b5] transition-colors">{label} <ArrowUpRight className="w-4 h-4" /></a>;
}
