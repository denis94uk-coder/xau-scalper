import { Outlet } from "react-router-dom";
import { AppSidebar } from "./AppSidebar";
import { MonitorBar } from "./MonitorBar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./ui/sidebar";

export function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 items-center px-4 md:hidden safe-top">
          <SidebarTrigger />
          <span className="ml-2 font-semibold text-sm text-[#D4A843]">
            XAU Scalper
          </span>
        </header>
        <main className="flex-1 p-3 sm:p-4 lg:p-6 pb-24">
          <Outlet />
        </main>
      </SidebarInset>
      <MonitorBar />
    </SidebarProvider>
  );
}
