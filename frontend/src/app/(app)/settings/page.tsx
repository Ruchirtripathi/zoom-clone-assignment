"use client";

import { useEffect, useState } from "react";
import { Copy, KeyRound, UserRound } from "lucide-react";
import { ensureIdentity, type UserIdentity } from "../../../lib/identity";
import { formatMeetingId } from "../../../lib/invite";

/**
 * Settings: the browser's meeting identity and personal room. Display-only
 * by design — the identity is established once per browser and shown here
 * exactly as the backend holds it.
 */
export default function SettingsPage() {
  const [identity, setIdentity] = useState<UserIdentity | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    ensureIdentity().then(setIdentity).catch((error) => console.error("Failed to load identity:", error));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <div className="max-w-[720px] mx-auto flex flex-col gap-6">
      <header>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-[-0.03em] text-slate-950">Settings</h1>
        <p className="mt-1.5 text-sm text-slate-500">Your profile and meeting preferences.</p>
      </header>

      <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.04)] p-6 flex items-center gap-4">
        <span className="w-14 h-14 rounded-full bg-[#b96e3d] text-white flex items-center justify-center text-lg font-semibold shrink-0">
          {(identity?.display_name || "R").split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="text-base font-semibold text-slate-900 truncate">{identity?.display_name || "Loading…"}</p>
          <p className="text-sm text-slate-500 mt-0.5">This is the name other participants see when you join a meeting.</p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.04)] p-6">
        <div className="flex items-center gap-2.5">
          <KeyRound className="w-4 h-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-900">Personal Meeting ID</h2>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-lg font-semibold tracking-[0.12em] text-slate-800 tabular-nums">{identity ? formatMeetingId(identity.personal_meeting_id) : "· · ·  · · ·  · · ·"}</p>
          {identity && (
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(identity.personal_meeting_id).then(() => setToast("Personal Meeting ID copied"))}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition-colors"
            >
              <Copy className="w-4 h-4" /> Copy
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-500">A permanent room — anyone with this ID can reach you there.</p>
      </section>

      <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.04)] p-6">
        <div className="flex items-center gap-2.5">
          <UserRound className="w-4 h-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-900">Profile</h2>
        </div>
        <div className="mt-3 divide-y divide-slate-100">
          <div className="flex items-center justify-between py-2.5"><span className="text-xs text-slate-500">Account type</span><span className="text-sm font-medium text-slate-800">Personal workspace</span></div>
          <div className="flex items-center justify-between py-2.5"><span className="text-xs text-slate-500">Devices</span><span className="text-sm font-medium text-slate-800">Configured per meeting in the lobby</span></div>
          <div className="flex items-center justify-between py-2.5"><span className="text-xs text-slate-500">Version</span><span className="text-sm font-medium text-slate-800">meetspace · Phase 10</span></div>
        </div>
      </section>

      {toast && <div role="status" className="fixed bottom-20 md:bottom-8 left-1/2 -translate-x-1/2 z-[85] rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm font-medium shadow-2xl">{toast}</div>}
    </div>
  );
}
