import {
  Award,
  BarChart3,
  CalendarDays,
  FlaskConical,
  Globe,
  LayoutDashboard,
  Lightbulb,
  ScrollText,
  Settings,
  Shield,
  Sparkles,
  Table2,
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
  { href: "/dashboard", label: "Crypto Dash", icon: LayoutDashboard },
];

const signalsNav = [
  { href: "/ideas", label: "Trading Ideas", icon: Lightbulb },
  { href: "/journal", label: "Signal Journal", icon: ScrollText },
];

const trackingNav = [
  { href: "/performance", label: "Performance", icon: BarChart3 },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/risk", label: "Risk Manager", icon: Shield },
];

const experimentalNav = [
  { href: "/experimental", label: "Teo'D'Or Lab", icon: FlaskConical },
  { href: "/experimental/ideas", label: "Exp Ideas", icon: Lightbulb },
  {
    href: "/experimental/performance",
    label: "Exp Performance",
    icon: BarChart3,
  },
  { href: "/experimental/calendar", label: "Exp Calendar", icon: CalendarDays },
  { href: "/experimental/journal", label: "Exp Journal", icon: ScrollText },
];

const topTenNav = [
  { href: "/top10", label: "Top 10", icon: Award },
  { href: "/top10/ideas", label: "Top 10 Ideas", icon: Lightbulb },
  { href: "/lse", label: "LSE", icon: Globe },
  { href: "/lse/ideas", label: "LSE Ideas", icon: Lightbulb },
];

const systemNav = [
  { href: "/research", label: "Find Strategies", icon: Sparkles },
  { href: "/strategies", label: "Strategy Carpet", icon: Table2 },
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

  // Journal after Calendar in both sections
  const mainMenu = [
    ...mainNav,
    signalsNav[0], // Ideas
    trackingNav[0], // Performance
    trackingNav[1], // Calendar
    signalsNav[1], // Journal
    trackingNav[2], // Risk
  ];

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupLabel className="text-[10px] text-muted-foreground uppercase tracking-wider">
          Teo&apos;D&apos;Or Lab
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {experimentalNav.map(item => (
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
          Top 10
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {topTenNav.map(item => (
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
        <SidebarGroupContent>
          <SidebarMenu>
            {mainMenu.map(item => (
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
          <span className="text-[#0A0C10] font-bold text-sm font-mono">T</span>
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
