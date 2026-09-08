"use client";

import Link from "next/link";
import { ArrowUpRight, CalendarDays, House, Settings } from "lucide-react";

const PLACES = [
  { href: "/", title: "Home", description: "Quick start actions, your personal room, and today's schedule.", icon: House },
  { href: "/meetings", title: "Meetings", description: "Upcoming and past meetings, invitations, and scheduling.", icon: CalendarDays },
  { href: "/settings", title: "Settings", description: "Your profile and Personal Meeting ID.", icon: Settings },
] as const;

/** A simple directory of the app's surfaces — nothing here pretends to do more than it does. */
export default function MorePage() {
  return (
    <div className="max-w-[880px] mx-auto flex flex-col gap-6">
      <header>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-[-0.03em] text-slate-950">More</h1>
        <p className="mt-1.5 text-sm text-slate-500">Everything else in your workspace.</p>
      </header>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {PLACES.map(({ href, title, description, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.04)] p-5 flex flex-col gap-3 hover:border-slate-300 hover:shadow-[0_12px_28px_rgba(15,23,42,0.07)] transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-[#edf3ff] text-[#2f6fed] flex items-center justify-center"><Icon className="w-[18px] h-[18px]" /></div>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
              <ArrowUpRight className="w-4 h-4 text-slate-400 group-hover:text-[#2f6fed] transition-colors" />
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">{description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
