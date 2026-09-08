import AppSidebar from "../../components/AppSidebar";
import AppHeader from "../../components/AppHeader";

/**
 * The app shell: left navigation, top header, scrollable content. Only
 * routes inside this group get the shell — /room/[meeting_id] renders
 * outside it, full-bleed, like a real meeting window.
 */
export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="h-dvh w-full flex overflow-hidden">
      <AppSidebar />
      <div className="flex-1 min-w-0 h-full flex flex-col">
        <AppHeader />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 pb-24 md:pb-8">
          {children}
        </main>
      </div>
    </div>
  );
}
