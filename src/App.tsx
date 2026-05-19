import { Route, Routes, Navigate } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import ErrorBoundary from "./components/ErrorBoundary";
import { Toaster } from "./components/ui/sonner";
import { ThemeProvider } from "./contexts/ThemeContext";
import {
  DashboardPage,
  TradingIdeasPage,
  PerformanceTrackerPage,
  ExperimentalPage,
  SignalJournalPage,
  RiskManagerPage,
} from "./pages";

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark" switchable={false}>
        <Toaster />
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/ideas" element={<TradingIdeasPage />} />
            <Route path="/journal" element={<SignalJournalPage />} />
            <Route path="/performance" element={<PerformanceTrackerPage />} />
            <Route path="/risk" element={<RiskManagerPage />} />
            <Route path="/experimental" element={<ExperimentalPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
