import {
  BarChart3,
  CalendarDays,
  LayoutDashboard,
  Lightbulb,
  ScrollText,
  Shield,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { APP_NAME } from "@/lib/constants";
import { AppSidebar } from "./AppSidebar";
import { MonitorBar } from "./MonitorBar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./ui/sidebar";

function MainPills() {
  const location = useLocation();
  const isMain =
    location.pathname === "/" ||
    location.pathname === "/dashboard" ||
    location.pathname.startsWith("/ideas") ||
    location.pathname.startsWith("/journal") ||
    location.pathname.startsWith("/performance") ||
    location.pathname.startsWith("/calendar") ||
    location.pathname.startsWith("/risk");
  if (!isMain) return null;
  return (
    <div className="sticky top-12 z-10 px-3 sm:px-4 lg:px-6 py-3 bg-[#0A0C10]/80 backdrop-blur supports-[backdrop-filter]:bg-[#0A0C10]/60 border-b border-white/5">
      <div className="flex gap-1 bg-[#12141A] rounded-lg p-1 border border-white/5 w-fit flex-wrap">
        {(
          [
            { href: "/dashboard", label: "Crypto Dash", icon: LayoutDashboard },
            { href: "/ideas", label: "Ideas", icon: Lightbulb },
            { href: "/performance", label: "Performance", icon: BarChart3 },
            { href: "/calendar", label: "Calendar", icon: CalendarDays },
            { href: "/journal", label: "Journal", icon: ScrollText },
            { href: "/risk", label: "Risk", icon: Shield },
          ] as const
        ).map(item => {
          const isActive =
            location.pathname === item.href ||
            (item.href === "/dashboard" && location.pathname === "/");
          return (
            <Link
              key={item.href}
              to={item.href}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors flex items-center gap-1.5 ${
                isActive
                  ? "bg-[#D4A843] text-black font-medium"
                  : "text-muted-foreground hover:text-white"
              }`}
            >
              <item.icon className="w-3.5 h-3.5" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function HeaderClockRefresh() {
  const location = useLocation();
  const isDash =
    location.pathname === "/" || location.pathname === "/dashboard";
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!isDash) return null;
  return (
    <div className="ml-auto flex items-center gap-2">
      <span className="text-xs font-mono text-muted-foreground hidden sm:inline">
        {now.toLocaleTimeString()}
      </span>
      <button
        onClick={() =>
          window.dispatchEvent(new CustomEvent("dashboard:refresh"))
        }
        className="h-7 px-2 text-xs rounded-md border border-border bg-card hover:bg-secondary transition-colors"
      >
        ↻ Refresh
      </button>
    </div>
  );
}

export function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center px-4 safe-top border-b border-white/5 bg-[#0A0C10]/80 backdrop-blur supports-[backdrop-filter]:bg-[#0A0C10]/60">
          <SidebarTrigger />
          <span className="ml-2 font-semibold text-sm text-[#D4A843] hidden md:inline">
            {APP_NAME}
          </span>
          <span className="ml-2 font-semibold text-sm text-[#D4A843] md:hidden">
            {APP_NAME}
          </span>
          <HeaderClockRefresh />
        </header>
        <MainPills />
        <main className="flex-1 p-2 sm:p-3 lg:p-4 pb-20">
          <Outlet />
        </main>
      </SidebarInset>
      <MonitorBar />
    </SidebarProvider>
  );
}
