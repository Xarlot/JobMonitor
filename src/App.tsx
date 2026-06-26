import { useState } from 'react';
import { Box, Flash, Heading, Octicon, Spinner, Text, UnderlineNav } from '@primer/react';
import {
  AppsIcon,
  GearIcon,
  GitPullRequestIcon,
  MarkGithubIcon,
  WorkflowIcon,
} from '@primer/octicons-react';
import { useAuth } from './context/AuthContext';
import { useConfig } from './context/ConfigContext';
import { DashboardProvider } from './context/DashboardContext';
import { FlowsRuntimeProvider } from './context/FlowsRuntimeContext';
import { FlowsFilterProvider } from './context/FlowsFilterContext';
import { RateLimitBadge } from './components/RateLimitBadge';
import { UnlockDialog } from './components/UnlockDialog';
import { Overview } from './components/Overview';
import { PrList } from './components/PrList';
import { FlowsView } from './components/FlowsView';
import { SettingsPage } from './components/SettingsPage';

type View = 'overview' | 'prs' | 'flows' | 'settings';

function Header() {
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
      <Heading as="h1" sx={{ fontSize: 2 }}>Job Monitor</Heading>
      <Text sx={{ fontSize: 0, color: 'fg.muted' }}>GitHub Actions dashboard</Text>
      <Box sx={{ flex: 1 }} />
      <RateLimitBadge />
    </Box>
  );
}

export function App() {
  const { status } = useAuth();
  const { complete } = useConfig();
  const [view, setView] = useState<View>('overview');
  const [focusFlowId, setFocusFlowId] = useState<string | null>(null);

  if (status === 'loading') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', pt: 8 }}>
        <Spinner />
      </Box>
    );
  }

  const effectiveView: View = status === 'needs-setup' ? 'settings' : view;
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
    { key: 'settings', label: 'Settings', icon: GearIcon },
  ];

  return (
    <Box sx={{ minHeight: '100vh', bg: 'canvas.default', color: 'fg.default' }}>
      <Header />

      {status === 'locked' ? (
        <UnlockDialog />
      ) : (
        <FlowsFilterProvider>
          <DashboardProvider>
            <FlowsRuntimeProvider>
              <Box sx={{ px: 3, pt: 2, borderBottom: '1px solid', borderColor: 'border.default' }}>
                <UnderlineNav aria-label="Main navigation">
                  {navItems.map((item) => (
                    <UnderlineNav.Item
                      key={item.key}
                      icon={item.icon}
                      aria-current={effectiveView === item.key ? 'page' : undefined}
                      onSelect={(e) => {
                        e.preventDefault();
                        if (item.key === 'settings' || !navDisabled) setView(item.key);
                      }}
                    >
                      {item.label}
                    </UnderlineNav.Item>
                  ))}
                </UnderlineNav>
              </Box>

              <Box sx={{ p: 4, maxWidth: 1200, mx: 'auto' }}>
                {status === 'needs-setup' && (
                  <Flash variant="warning" sx={{ mb: 4 }}>
                    Add a GitHub token below to start monitoring.
                  </Flash>
                )}
                {effectiveView === 'overview' &&
                  (complete ? <Overview onOpenFlow={openFlow} onOpenPrs={openPrs} /> : <ConfigHint />)}
                {effectiveView === 'prs' && (complete ? <PrList /> : <ConfigHint />)}
                {effectiveView === 'flows' &&
                  (complete ? <FlowsView focusFlowId={focusFlowId} /> : <ConfigHint />)}
                {effectiveView === 'settings' && <SettingsPage />}
              </Box>
            </FlowsRuntimeProvider>
          </DashboardProvider>
        </FlowsFilterProvider>
      )}
    </Box>
  );
}

function ConfigHint() {
  return (
    <Flash variant="default">
      Set the upstream owner/repo and fork owner in <strong>Settings</strong> to begin.
    </Flash>
  );
}
