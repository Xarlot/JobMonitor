import { useEffect, useState } from 'react';
import { Box, Button, Flash, Heading, IconButton, Octicon, Spinner, Text, UnderlineNav } from '@primer/react';
import {
  AppsIcon,
  ArrowLeftIcon,
  DeviceDesktopIcon,
  GearIcon,
  GitPullRequestIcon,
  MarkGithubIcon,
  MoonIcon,
  SunIcon,
  WorkflowIcon,
} from '@primer/octicons-react';
import { useAuth } from './context/AuthContext';
import { useTheme } from './context/ThemeContext';
import { useConfig } from './context/ConfigContext';
import { DashboardProvider } from './context/DashboardContext';
import { FlowsRuntimeProvider } from './context/FlowsRuntimeContext';
import { FlowsFilterProvider } from './context/FlowsFilterContext';
import { ViewModeProvider } from './context/ViewModeContext';
import { StatsBadge } from './components/StatsBadge';
import { UnlockDialog } from './components/UnlockDialog';
import { Overview } from './components/Overview';
import { PrList } from './components/PrList';
import { FlowsView } from './components/FlowsView';
import { SettingsPage } from './components/SettingsPage';
import { setAutoUpdateEnabled } from './storage/desktopUpdates';

type View = 'overview' | 'prs' | 'flows';

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
  const [view, setView] = useState<View>('overview');
  const [focusFlowId, setFocusFlowId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Keep the desktop shell's auto-updater in sync with the user's setting.
  useEffect(() => {
    void setAutoUpdateEnabled(config.autoUpdate);
  }, [config.autoUpdate]);

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

  const navItems: { key: View; label: string; icon: typeof AppsIcon }[] = [
    { key: 'overview', label: 'Overview', icon: AppsIcon },
    { key: 'prs', label: 'Pull requests', icon: GitPullRequestIcon },
    { key: 'flows', label: 'Flows', icon: WorkflowIcon },
  ];

  return (
    <Box sx={{ minHeight: '100vh', bg: 'canvas.default', color: 'fg.default' }}>
      <Header onSettings={() => setSettingsOpen((v) => !v)} settingsActive={showSettings} />

      {status === 'locked' ? (
        <UnlockDialog />
      ) : (
        <ViewModeProvider>
          <FlowsFilterProvider>
            <DashboardProvider>
              <FlowsRuntimeProvider>
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
                    <Box sx={{ p: 4, maxWidth: 1200, mx: 'auto' }}>
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
                    <Box sx={{ px: 3, pt: 2, borderBottom: '1px solid', borderColor: 'border.default' }}>
                      <UnderlineNav aria-label="Main navigation">
                        {navItems.map((item) => (
                          <UnderlineNav.Item
                            key={item.key}
                            icon={item.icon}
                            aria-current={view === item.key ? 'page' : undefined}
                            onSelect={(e) => {
                              e.preventDefault();
                              if (!navDisabled) setView(item.key);
                            }}
                          >
                            {item.label}
                          </UnderlineNav.Item>
                        ))}
                      </UnderlineNav>
                    </Box>

                    <Box sx={{ p: 4, maxWidth: 1200, mx: 'auto' }}>
                      {view === 'overview' &&
                        (complete ? <Overview onOpenFlow={openFlow} onOpenPrs={openPrs} /> : <ConfigHint />)}
                      {view === 'prs' && (complete ? <PrList /> : <ConfigHint />)}
                      {view === 'flows' && (complete ? <FlowsView focusFlowId={focusFlowId} /> : <ConfigHint />)}
                    </Box>
                  </>
                )}
              </FlowsRuntimeProvider>
            </DashboardProvider>
          </FlowsFilterProvider>
        </ViewModeProvider>
      )}
    </Box>
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
