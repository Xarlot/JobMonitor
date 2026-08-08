import { useEffect, useState, type ReactNode } from 'react';
import { Box, Button, Flash, Heading, IconButton, Octicon, Spinner, Text, UnderlineNav } from '@primer/react';
import {
  AppsIcon,
  ArrowLeftIcon,
  BugIcon,
  DeviceDesktopIcon,
  GearIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  MarkGithubIcon,
  MoonIcon,
  SunIcon,
  TerminalIcon,
  WorkflowIcon,
} from '@primer/octicons-react';
import { useAuth } from './context/AuthContext';
import { useTheme } from './context/ThemeContext';
import { useConfig } from './context/ConfigContext';
import { useCapabilityProbe } from './hooks/useCapabilityProbe';
import { DashboardProvider } from './context/DashboardContext';
import { AutoRerunProvider } from './context/AutoRerunContext';
import { FeatureBranchesProvider } from './context/FeatureBranchesContext';
import { NavigationProvider } from './context/NavigationContext';
import { FailuresProvider, useFailures } from './context/FailuresContext';
import { FlowsRuntimeProvider } from './context/FlowsRuntimeContext';
import { ResolvedFlowsProvider } from './context/ResolvedFlowsContext';
import { FlowsFilterProvider } from './context/FlowsFilterContext';
import { ViewModeProvider } from './context/ViewModeContext';
import { StatsBadge } from './components/StatsBadge';
import { DownloadsButton } from './components/DownloadsButton';
import { UnlockDialog } from './components/UnlockDialog';
import { Overview } from './components/Overview';
import { PrList } from './components/PrList';
import { FlowsView } from './components/FlowsView';
import { FailuresView } from './components/FailuresView';
import { DiagnosticsView } from './components/DiagnosticsView';
import { FeatureBranchesView } from './components/FeatureBranchesView';
import { SettingsPage } from './components/SettingsPage';
import { setAutoUpdateEnabled } from './storage/desktopUpdates';
import { isDesktop } from './storage/desktopSecret';

type View = 'overview' | 'prs' | 'branches' | 'flows' | 'failures' | 'diagnostics';

const THEME_ICON = { auto: DeviceDesktopIcon, light: SunIcon, dark: MoonIcon } as const;

function Header({ onSettings, settingsActive }: { onSettings: () => void; settingsActive: boolean }) {
  const { mode, cycle } = useTheme();
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 3,
        py: 2,
        bg: 'canvas.inset',
        borderBottom: '1px solid',
        borderColor: 'border.default',
      }}
    >
      <Octicon icon={MarkGithubIcon} size={28} />
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
        <Heading as="h1" sx={{ fontSize: 2 }}>Job Monitor</Heading>
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>GitHub Actions dashboard</Text>
        <Text
          sx={{ fontSize: 0, color: 'fg.muted', fontFamily: 'mono' }}
          title={`Job Monitor v${__APP_VERSION__}`}
        >
          v{__APP_VERSION__}
        </Text>
      </Box>
      <Box sx={{ flex: 1 }} />
      <StatsBadge />
      <DownloadsButton />
      <IconButton
        icon={THEME_ICON[mode]}
        aria-label={`Theme: ${mode} (click to change)`}
        variant="invisible"
        onClick={cycle}
      />
      <IconButton
        icon={GearIcon}
        aria-label="Settings"
        variant={settingsActive ? 'default' : 'invisible'}
        onClick={onSettings}
      />
    </Box>
  );
}

export function App() {
  const { status } = useAuth();
  const { config, complete } = useConfig();
  // Determines whether the token may re-run jobs; gates every write control.
  useCapabilityProbe();
  const [view, setView] = useState<View>('overview');
  const [focusFlowId, setFocusFlowId] = useState<string | null>(null);
  const [focusPrNumber, setFocusPrNumber] = useState<number | null>(null);
  const [focusFailureKey, setFocusFailureKey] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Bumped on every navigation request, so repeating one still re-scrolls. */
  const [focusNonce, setFocusNonce] = useState(0);

  // Opt-in, and only where the log exists: a browser tab has no file to read.
  const showDiagnostics = isDesktop() && config.diagnostics.showLogTab;
  // Opt-in, and pointless without coordinates: everything on it is a comparison
  // between the fork and the upstream.
  const showBranches = complete && config.featureBranches.enabled;

  // Keep the desktop shell's auto-updater in sync with the user's setting.
  useEffect(() => {
    void setAutoUpdateEnabled(config.autoUpdate);
  }, [config.autoUpdate]);

  // Switching the tab off while standing on it would otherwise leave the content area
  // blank with no nav item to leave by.
  useEffect(() => {
    if (!showDiagnostics && view === 'diagnostics') setView('overview');
    if (!showBranches && view === 'branches') setView('overview');
  }, [showDiagnostics, showBranches, view]);

  if (status === 'loading') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', pt: 8 }}>
        <Spinner />
      </Box>
    );
  }

  // Settings is a full-screen view opened from the header gear (not a nav tab).
  // It's forced open until a token exists (needs-setup).
  const showSettings = settingsOpen || status === 'needs-setup';
  const navDisabled = status !== 'unlocked';

  const openFlow = (flowId: string) => {
    setFocusFlowId(flowId);
    setView('flows');
  };
  const openPrs = () => setView('prs');
  /**
   * Jump to one pull request in the Pull requests tab.
   *
   * The counter is part of the state so that asking for the *same* pull request twice still
   * re-triggers the scroll — without it, a second click after scrolling away would change
   * nothing and read as a broken button.
   */
  const openPr = (prNumber: number) => {
    setFocusPrNumber(prNumber);
    setFocusNonce((n) => n + 1);
    setView('prs');
  };
  /** Open the Failures tab at one failure — from a failing check or job in a run. */
  const openFailure = (failureKey: string) => {
    setFocusFailureKey(failureKey);
    setFocusNonce((n) => n + 1);
    setView('failures');
  };

  return (
    <Box sx={{ minHeight: '100vh', bg: 'canvas.default', color: 'fg.default' }}>
      <Header onSettings={() => setSettingsOpen((v) => !v)} settingsActive={showSettings} />

      {status === 'locked' ? (
        <UnlockDialog />
      ) : (
        <DataProviders>
          {/*
            Inside the data providers, because a control that navigates to a failure first
            has to ask the failure list whether that failure is there to navigate to.
          */}
          <NavigationProvider value={{ openPr, openFailure }}>
          {showSettings ? (
            <>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  px: 3,
                  py: 2,
                  borderBottom: '1px solid',
                  borderColor: 'border.default',
                }}
              >
                <Octicon icon={GearIcon} size={18} sx={{ color: 'fg.muted' }} />
                <Heading as="h2" sx={{ fontSize: 2 }}>Settings</Heading>
                <Box sx={{ flex: 1 }} />
                {status !== 'needs-setup' && (
                  <Button leadingVisual={ArrowLeftIcon} onClick={() => setSettingsOpen(false)}>
                    Back to dashboard
                  </Button>
                )}
              </Box>
              <Box sx={{ p: 4, maxWidth: 1440, mx: 'auto' }}>
                {status === 'needs-setup' && (
                  <Flash variant="warning" sx={{ mb: 4 }}>
                    Add a GitHub token below to start monitoring.
                  </Flash>
                )}
                <SettingsPage />
              </Box>
            </>
          ) : (
            <>
              <MainNav
                view={view}
                disabled={navDisabled}
                showDiagnostics={showDiagnostics}
                showBranches={showBranches}
                onSelect={setView}
              />

              {/*
                Full width. The dashboard's content is grids, tables and a two-column
                master/detail — all of which use the room: capping at 1200px left a wide
                window mostly empty while the failure list and its report fought over the
                same 1200. The Settings page below keeps a cap, because that one is a form —
                but a generous one: what benefits from the room there is the multi-column
                rows and the flow editor, not the text fields, which carry their own widths
                and stay readable however wide the window gets.
              */}
              <Box sx={{ p: 4 }}>
                {view === 'overview' &&
                  (complete ? <Overview onOpenFlow={openFlow} onOpenPrs={openPrs} /> : <ConfigHint />)}
                {view === 'prs' &&
                  (complete ? (
                    <PrList key={`focus-${focusNonce}`} focusPrNumber={focusPrNumber} />
                  ) : (
                    <ConfigHint />
                  ))}
                {view === 'branches' && showBranches && <FeatureBranchesView />}
                {view === 'flows' && (complete ? <FlowsView focusFlowId={focusFlowId} /> : <ConfigHint />)}
                {view === 'failures' &&
                  (complete ? (
                    <FailuresView focusFailure={{ target: focusFailureKey, nonce: focusNonce }} />
                  ) : (
                    <ConfigHint />
                  ))}
                {/*
                  No `complete` gate: this one reads a local file rather than GitHub, and
                  an unconfigured app is a state you might well be diagnosing.
                */}
                {view === 'diagnostics' && showDiagnostics && <DiagnosticsView />}
              </Box>
            </>
          )}
          </NavigationProvider>
        </DataProviders>
      )}
    </Box>
  );
}

/**
 * Main navigation. Rendered inside the data providers so the Failures tab can
 * carry a live count of what needs attention — the whole point of that tab is to
 * notice a failure without going looking for it.
 */
function MainNav({
  view,
  disabled,
  showDiagnostics,
  showBranches,
  onSelect,
}: {
  view: View;
  disabled: boolean;
  showDiagnostics: boolean;
  showBranches: boolean;
  onSelect: (view: View) => void;
}) {
  const failureCount = useFailures().failures.length;

  const navItems: { key: View; label: string; icon: typeof AppsIcon; counter?: number }[] = [
    { key: 'overview', label: 'Overview', icon: AppsIcon },
    { key: 'prs', label: 'Pull requests', icon: GitPullRequestIcon },
  ];
  // Next to Pull requests, since that is what it deals in — just the ones the PR tab
  // cannot show, because both their ends are in the upstream.
  if (showBranches) {
    navItems.push({ key: 'branches', label: 'Feature branches', icon: GitBranchIcon });
  }
  navItems.push(
    { key: 'flows', label: 'Flows', icon: WorkflowIcon },
    { key: 'failures', label: 'Failures', icon: BugIcon, counter: failureCount || undefined },
  );
  // Last, and only when asked for: it is about the app rather than about the work.
  if (showDiagnostics) {
    navItems.push({ key: 'diagnostics', label: 'Diagnostics', icon: TerminalIcon });
  }

  return (
    <Box sx={{ px: 3, pt: 2, borderBottom: '1px solid', borderColor: 'border.default' }}>
      <UnderlineNav aria-label="Main navigation">
        {navItems.map((item) => (
          <UnderlineNav.Item
            key={item.key}
            icon={item.icon}
            counter={item.counter}
            aria-current={view === item.key ? 'page' : undefined}
            onSelect={(e) => {
              e.preventDefault();
              if (!disabled) onSelect(item.key);
            }}
          >
            {item.label}
          </UnderlineNav.Item>
        ))}
      </UnderlineNav>
    </Box>
  );
}

/**
 * The always-mounted data layer, in dependency order: view/filter preferences,
 * then PR polling, then the auto-rerun engine that reads it, then flow resolution
 * and the per-flow runtimes. Kept outside the tab switch so every one of them
 * keeps working whichever view is on screen.
 */
function DataProviders({ children }: { children: ReactNode }) {
  return (
    <ViewModeProvider>
      <FlowsFilterProvider>
        <DashboardProvider>
          {/*
            Above the auto-rerun engine, which consumes its pull requests: they are
            invisible to the dashboard's fork-head filter, so nothing else would ever
            re-run their failed jobs.
          */}
          <FeatureBranchesProvider>
            <AutoRerunProvider>
              <ResolvedFlowsProvider>
                <FlowsRuntimeProvider>
                  {/* Innermost: the failure list reads both PR state and flow runs. */}
                  <FailuresProvider>{children}</FailuresProvider>
                </FlowsRuntimeProvider>
              </ResolvedFlowsProvider>
            </AutoRerunProvider>
          </FeatureBranchesProvider>
        </DashboardProvider>
      </FlowsFilterProvider>
    </ViewModeProvider>
  );
}

function ConfigHint() {
  return (
    <Flash variant="default">
      Open <strong>Settings</strong> (gear, top-right) and set the upstream owner/repo and fork owner
      to begin.
    </Flash>
  );
}
