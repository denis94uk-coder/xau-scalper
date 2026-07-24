import { useConvexAuth } from "convex/react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export default function LandingPage() {
  const { isAuthenticated } = useConvexAuth();

  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] px-4">
      <div className="flex flex-col items-center gap-8 max-w-2xl text-center">
        {/* Logo / Symbol */}
        <div className="relative">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-[#D4A843] to-[#9A7A30] flex items-center justify-center shadow-lg shadow-[#D4A843]/20">
            <span className="text-3xl font-bold text-[#0A0C10] font-mono">
              Au
            </span>
          </div>
          <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[#00E676] animate-pulse-dot" />
        </div>

        {/* Title */}
        <div className="flex flex-col gap-3">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            <span className="text-[#D4A843]">XAU</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-foreground">USD</span>
            <span className="text-muted-foreground ml-3 text-2xl sm:text-3xl">
              Scalper
            </span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-md mx-auto leading-relaxed">
            Real-time gold scalping dashboard with multi-timeframe analysis,
            technical indicators, and trade journaling.
          </p>
        </div>

        {/* Features */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-lg">
          {[
            { label: "3m · 5m · 15m", desc: "Multi-timeframe" },
            { label: "RSI · MACD · EMA", desc: "Technical signals" },
            { label: "Buy · Sell · Track", desc: "Trade journal" },
          ].map(f => (
            <div
              key={f.label}
              className="flex flex-col items-center gap-1 p-3 rounded-lg bg-card border border-border"
            >
              <span className="text-sm font-mono font-semibold text-[#D4A843]">
                {f.label}
              </span>
              <span className="text-xs text-muted-foreground">{f.desc}</span>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="flex gap-3">
          {isAuthenticated ? (
            <Button
              asChild
              className="bg-[#D4A843] hover:bg-[#B8922F] text-[#0A0C10] font-bold h-11 px-8"
            >
              <Link to="/dashboard">Open Dashboard</Link>
            </Button>
          ) : (
            <>
              <Button
                asChild
                className="bg-[#D4A843] hover:bg-[#B8922F] text-[#0A0C10] font-bold h-11 px-8"
              >
                <Link to="/signup">Get Started</Link>
              </Button>
              <Button
                asChild
                variant="outline"
                className="h-11 px-6 border-border"
              >
                <Link to="/login">Sign In</Link>
              </Button>
            </>
          )}
        </div>

        {/* Disclaimer */}
        <p className="text-xs text-muted-foreground/60 max-w-sm">
          For educational and analysis purposes. Not financial advice. Trade at
          your own risk.
        </p>
      </div>
    </div>
  );
}
