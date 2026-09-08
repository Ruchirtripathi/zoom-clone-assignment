"use client";

import { Calendar, Home, MessageSquare, MoreHorizontal, Settings, Video } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Home", icon: Home },
  { href: "/meetings", label: "Meetings", icon: Calendar },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/more", label: "More", icon: MoreHorizontal },
];

function useIsActive(href: string) {
  const pathname = usePathname();
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function DesktopItem({ href, label, icon: Icon }: { href: string; label: string; icon: typeof Home }) {
  const active = useIsActive(href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 px-3 py-3 rounded-xl transition-colors ${
        active
          ? "bg-white shadow-sm font-semibold text-slate-900"
          : "text-slate-500 hover:bg-white hover:text-slate-900 font-medium"
      }`}
    >
      <Icon className={`w-[18px] h-[18px] ${active ? "text-[#205bd7]" : ""}`} />
      <span className="hidden lg:block text-sm">{label}</span>
    </Link>
  );
}

function MobileItem({ href, label, icon: Icon }: { href: string; label: string; icon: typeof Home }) {
  const active = useIsActive(href);
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={`flex flex-col items-center justify-center w-full h-full ${active ? "text-[#205bd7]" : "text-slate-500"}`}>
      <Icon className={`w-6 h-6 ${active ? "stroke-[2.5]" : "stroke-[2]"}`} />
      <span className={`text-xs mt-1 ${active ? "font-semibold" : "font-medium"}`}>{label}</span>
    </Link>
  );
}

/**
 * The app's left navigation. The active page reads as raised: a white pill
 * with stronger typography and a hint of the product blue on the icon —
 * blue is reserved for selection and primary actions, not decoration.
 */
export default function AppSidebar() {
  return (
    <>
      {/* Desktop rail */}
      <aside className="hidden md:flex w-20 lg:w-[228px] bg-[#f7f8fa] border-r border-slate-200/80 flex-col items-center lg:items-stretch px-3 lg:px-4 py-5 z-10 h-full shrink-0">
        <div className="px-1 lg:px-3 mb-10 flex items-center gap-3">
          <div className="w-9 h-9 bg-[#2f6fed] rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/20">
            <Video className="w-5 h-5 text-white" />
          </div>
          <span className="hidden lg:block text-[17px] font-semibold tracking-[-0.03em]">meetspace</span>
        </div>
        <nav className="flex-1 w-full space-y-1">
          {NAV_ITEMS.map((item) => <DesktopItem key={item.href} {...item} />)}
        </nav>
        <DesktopItem href="/settings" label="Settings" icon={Settings} />
      </aside>

      {/* Mobile bottom navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-slate-200 flex justify-around items-center h-16 z-50">
        {[NAV_ITEMS[0], NAV_ITEMS[1], NAV_ITEMS[2], { href: "/settings", label: "Settings", icon: Settings }].map((item) => (
          <MobileItem key={item.href} {...item} />
        ))}
      </nav>
    </>
  );
}
