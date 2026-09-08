"use client";

import { VideoOff } from "lucide-react";

/**
 * Shown when a meeting link or ID does not resolve to a meeting. Product
 * copy only — the raw 404 never reaches the user.
 */
export default function MeetingNotFound({ onHome, onMeetings }: { onHome: () => void; onMeetings: () => void }) {
  return (
    <div data-meeting-not-found className="h-dvh w-full bg-[#0d1117] text-white flex items-center justify-center p-6">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-white/10 text-slate-300 flex items-center justify-center" aria-hidden="true"><VideoOff className="w-6 h-6" /></div>
        <h2 className="mt-6 text-2xl font-semibold tracking-[-0.02em]">Meeting not found</h2>
        <p className="mt-3 text-sm text-slate-400">This meeting may have been deleted or the link may be incorrect.</p>
        <div className="mt-8 flex flex-col gap-2">
          <button onClick={onHome} className="w-full rounded-xl bg-[#2f6fed] px-4 py-3 text-sm font-semibold hover:bg-[#245dcc] transition-colors">Back to Home</button>
          <button onClick={onMeetings} className="w-full rounded-xl bg-white/10 px-4 py-3 text-sm font-semibold text-slate-200 hover:bg-white/15 transition-colors">View your meetings</button>
        </div>
      </div>
    </div>
  );
}
