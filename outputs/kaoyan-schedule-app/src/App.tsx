import { Component, lazy, Suspense, useEffect, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react';
import { WebAppShell } from './components/WebAppShell';
import { getAppLocation, subscribeAppLocation } from './utils/appNavigation';
import { IS_CLOUD_RUNTIME } from './utils/runtime';
import { prepareRemotePrivateStorage } from './utils/remoteDataPolicy';
import './wallpaper.css';
import './notes.css';
import './theme-fifth.css';
import './desktop/desktop.css';
import './desktop/desktop-fixes.css';
import './desktop/desktop-console-overrides.css';
import './desktop/dunhuang-backdrop.css';
import './note-capture.css';
import './note-drop-app.css';
import './app-hub.css';
import './web-experience.css';
import './web-app-shell.css';
import './ai-config.css';

const AppHub = lazy(() => import('./components/AppHub').then((module) => ({ default: module.AppHub })));
const ScheduleApp = lazy(() => import('./components/ScheduleApp').then((module) => ({ default: module.ScheduleApp })));
const NoteCapturePage = lazy(() => import('./components/NoteCapturePage').then((module) => ({ default: module.NoteCapturePage })));
const NoteDropApp = lazy(() => import('./components/NoteDropApp').then((module) => ({ default: module.NoteDropApp })));
const LearningRecordWorkspacePreview = lazy(() => import('./components/LearningRecordWorkspacePreview').then((module) => ({ default: module.LearningRecordWorkspacePreview })));
const DesktopConsole = lazy(() => import('./desktop/DesktopConsole').then((module) => ({ default: module.DesktopConsole })));
const DesktopWorkspace = lazy(() => import('./desktop/DesktopWorkspace').then((module) => ({ default: module.DesktopWorkspace })));
const AiConfigPage = lazy(() => import('./components/AiConfigPage').then((module) => ({ default: module.AiConfigPage })));
const ActivityCenter = lazy(() => import('./components/ActivityCenter').then((module) => ({ default: module.ActivityCenter })));
const CommandPalette = lazy(() => import('./components/CommandPalette').then((module) => ({ default: module.CommandPalette })));

const RouteLoading = () => <div className="route-loading" role="status"><span /><strong>正在打开学习工作台…</strong></div>;
class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Route rendering failed', error, info); }
  render() {
    if (this.state.failed) return <div className="route-error"><strong>页面没有成功加载</strong><p>你的数据没有受影响，可以刷新后继续。</p><button type="button" onClick={() => window.location.reload()}>重新加载</button></div>;
    return this.props.children;
  }
}
const deferred = (content: ReactNode, routeKey: string) => <RouteErrorBoundary key={routeKey}><Suspense fallback={<RouteLoading />}>{content}</Suspense></RouteErrorBoundary>;
const palette = () => <Suspense fallback={null}><CommandPalette /></Suspense>;

export default function App() {
  prepareRemotePrivateStorage();
  const appLocation = useSyncExternalStore(subscribeAppLocation, getAppLocation, getAppLocation);

  useEffect(() => {
    void import('./utils/activityTasks').then(({ initializeActivityTasks }) => initializeActivityTasks()).catch(() => undefined);
    return undefined;
  }, []);

  useEffect(() => {
    if (!IS_CLOUD_RUNTIME) return undefined;
    let active = true;
    let dispose: (() => void) | undefined;
    void Promise.all([
      import('./utils/captureUploadQueue'),
      import('./utils/noteBackgroundJobs'),
    ]).then(([{ installCaptureUploadResumer }, { installMultiQuestionJobResumer }]) => {
      if (!active) return;
      const disposeCapture = installCaptureUploadResumer();
      const disposeMultiQuestion = installMultiQuestionJobResumer();
      dispose = () => {
        disposeCapture();
        disposeMultiQuestion();
      };
    }).catch(() => undefined);
    return () => {
      active = false;
      dispose?.();
    };
  }, []);

  const params = new URLSearchParams(appLocation.split('?')[1]?.split('#')[0] ?? '');
  const isWallpaperMode = params.get('wallpaper') === '1';
  const isConsoleMode = params.get('console') === '1';
  const isNotesMode = params.get('notes') === '1';
  const isNoteAppMode = params.get('noteApp') === '1';
  const isHubMode = params.get('hub') === '1';
  const isAiConfigMode = params.get('aiConfig') === '1';
  const isActivityMode = params.get('activity') === '1';
  const workspaceNoteUid = params.get('workspaceNote')?.trim() || '';

  if (workspaceNoteUid) {
    return deferred(<LearningRecordWorkspacePreview noteUid={workspaceNoteUid} />, appLocation);
  }

  if (IS_CLOUD_RUNTIME && (isAiConfigMode || isConsoleMode || isWallpaperMode)) {
    return <WebAppShell active="hub">{deferred(<AppHub />, appLocation)}{palette()}</WebAppShell>;
  }

  if (isWallpaperMode && !window.kaoyanDesktop?.isElectron) {
    return <WebAppShell active="hub">{deferred(<AppHub />, appLocation)}{palette()}</WebAppShell>;
  }

  if (isAiConfigMode) {
    return <WebAppShell active="ai-config">{deferred(<AiConfigPage />, appLocation)}{palette()}</WebAppShell>;
  }

  if (isHubMode) {
    return <WebAppShell active="hub">{deferred(<AppHub />, appLocation)}{palette()}</WebAppShell>;
  }

  // The same capture route serves Electron, LAN browsers and Cloudflare.
  // The component chooses the compact mobile flow from the actual viewport.
  if (isNoteAppMode) {
    return deferred(<NoteDropApp />, appLocation);
  }

  if (isActivityMode) {
    return <WebAppShell active="activity">{deferred(<ActivityCenter />, appLocation)}{palette()}</WebAppShell>;
  }

  if (isNotesMode) {
    return <WebAppShell active="notes">{deferred(<NoteCapturePage />, appLocation)}{palette()}</WebAppShell>;
  }

  if (isConsoleMode) {
    return <WebAppShell active="console">{deferred(<DesktopConsole />, appLocation)}{palette()}</WebAppShell>;
  }

  if (isWallpaperMode) {
    return deferred(<DesktopWorkspace editable={false} />, appLocation);
  }

  const activeScheduleView = params.get('panel') === 'learning' ? 'learning' : 'schedule';
  return <WebAppShell active={activeScheduleView}>{deferred(<ScheduleApp key={appLocation} />, appLocation)}{palette()}</WebAppShell>;
}
