import {
  BarChart3,
  FlaskConical,
  LayoutDashboard,
  Lightbulb,
  ScrollText,
  Settings,
  Shield,
  Sparkles,
} from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { APP_NAME } from "@/lib/constants";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar";

const mainNav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/experimental", label: "Experimental Lab", icon: FlaskConical },
];

const signalsNav = [
  { href: "/ideas", label: "Trading Ideas", icon: Lightbulb },
  { href: "/journal", label: "Signal Journal", icon: ScrollText },
];

const trackingNav = [
  { href: "/performance", label: "Performance", icon: BarChart3 },
  { href: "/risk", label: "Risk Manager", icon: Shield },
];

const systemNav = [
  { href: "/research", label: "Find Strategies", icon: Sparkles },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavLink({
  href,
  label,
  icon: Icon,
  isActive,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  isActive: boolean;
}) {
  const { setOpenMobile } = useSidebar();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive}>
        <Link to={href} onClick={() => setOpenMobile(false)}>
          <Icon />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function SidebarNav() {
  const location = useLocation();

  const isActive = (href: string) =>
    location.pathname === href ||
    (href === "/dashboard" && location.pathname === "/");

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {mainNav.map(item => (
              <NavLink
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                isActive={isActive(item.href)}
              />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel className="text-[10px] text-muted-foreground uppercase tracking-wider">
          Signals
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {signalsNav.map(item => (
              <NavLink
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                isActive={isActive(item.href)}
              />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel className="text-[10px] text-muted-foreground uppercase tracking-wider">
          Tracking
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {trackingNav.map(item => (
              <NavLink
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                isActive={isActive(item.href)}
              />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel className="text-[10px] text-muted-foreground uppercase tracking-wider">
          System
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {systemNav.map(item => (
              <NavLink
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                isActive={isActive(item.href)}
              />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}

function SidebarHeaderContent() {
  const { setOpenMobile } = useSidebar();

  return (
    <SidebarHeader className="border-b border-sidebar-border">
      <Link
        to="/"
        onClick={() => setOpenMobile(false)}
        className="flex items-center gap-2.5 px-2 py-1 font-semibold text-lg"
      >
        <div className="size-8 rounded-lg bg-gradient-to-br from-[#D4A843] to-[#9A7A30] flex items-center justify-center">
          <span className="text-[#0A0C10] font-bold text-sm font-mono">Au</span>
        </div>
        <span>{APP_NAME}</span>
      </Link>
    </SidebarHeader>
  );
}

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeaderContent />
      <SidebarNav />
    </Sidebar>
  );
}
