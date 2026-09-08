"use client";

import { MessagesSquare } from "lucide-react";
import Link from "next/link";

/**
 * Chat lives inside meetings (with history and unread counts on the room's
 * chat panel). This page is the app-level surface for it — an honest,
 * polished placeholder rather than a fake inbox.
 */
export default function ChatPage() {
  return (
    <div className="max-w-[1240px] mx-auto flex flex-col gap-6">
      <header>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-[-0.03em] text-slate-950">Chat</h1>
        <p className="mt-1.5 text-sm text-slate-500">Conversations from your meetings.</p>
      </header>
      <div className="rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.04)] p-12 flex flex-col items-center justify-center text-center min-h-[320px]">
        <div className="w-14 h-14 mb-4 rounded-2xl bg-[#edf3ff] text-[#2f6fed] flex items-center justify-center"><MessagesSquare className="w-6 h-6" /></div>
        <p className="text-slate-900 font-semibold">No conversations yet</p>
        <p className="text-slate-500 text-sm mt-1 max-w-[320px]">Chat is available inside every meeting — open a room and use the chat button in the toolbar. History and unread counts are kept per meeting.</p>
        <Link href="/meetings" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[#2f6fed] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#245dcc] transition-colors">Go to Meetings</Link>
      </div>
    </div>
  );
}
