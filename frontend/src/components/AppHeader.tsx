"use client";

import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "M";
}

/**
 * Top app bar: product name, browser-history navigation, the search field
 * (a polished, honest placeholder — it is presentational and never claims
 * to run a real search), and the profile chip for the browser's identity.
 * Only rendered inside the app shell — meeting rooms are full-bleed.
 */
export default function AppHeader() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    // The identity exists before any page that needs it runs; the header is
    // display-only, so a plain read is enough (no registration here).
    setDisplayName(localStorage.getItem("meetspace_display_name") || "Ruchir Tripathi");
  }, []);

  return (
    <header className="h-14 shrink-0 bg-white border-b border-slate-200/80 flex items-center gap-3 px-4 md:px-6 z-20">
      <div className="hidden sm:flex items-center gap-1">
        <button onClick={() => router.back()} className="w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center transition-colors" aria-label="Go back" title="Go back">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button onClick={() => router.forward()} className="w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center transition-colors" aria-label="Go forward" title="Go forward">
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
      <span className="text-[15px] font-semibold tracking-[-0.02em] text-slate-900">meetspace</span>

      <div className="flex-1 flex justify-center min-w-0">
        {/* Presentational search field — Search is a UI preview in this build,
            not a working search, so it is a div rather than a lying input. */}
        <div className="w-full max-w-md hidden sm:flex items-center gap-2.5 rounded-xl border border-slate-200 bg-[#f7f8fa] px-3.5 h-9 text-slate-400" title="Search is not available in this build">
          <Search className="w-4 h-4 shrink-0" />
          <span className="text-sm">Search</span>
          <span className="ml-auto flex items-center gap-0.5">
            <kbd className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">Ctrl</kbd>
            <kbd className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">K</kbd>
          </span>
        </div>
      </div>

      <Link href="/settings" className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-slate-100 transition-colors" aria-label="Open settings and profile">
        <span className="hidden md:block text-sm font-medium text-slate-700 max-w-[160px] truncate">{displayName || "—"}</span>
        <span className="w-9 h-9 rounded-full bg-[#b96e3d] text-white flex items-center justify-center text-xs font-semibold shrink-0">{initials(displayName)}</span>
      </Link>
    </header>
  );
}
