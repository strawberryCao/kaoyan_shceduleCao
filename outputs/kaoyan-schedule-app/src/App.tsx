import { lazy, Suspense, type ReactNode } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { WebAppShell } from './components/WebAppShell';
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
const DesktopConsole = lazy(() => import('./desktop/DesktopConsole').then((module) => ({ default: module.DesktopConsole })));
const DesktopWorkspace = lazy(() => import('./desktop/DesktopWorkspace').then((module) => ({ default: module.DesktopWorkspace })));
const AiConfigPage = lazy(() => import('./components/AiConfigPage').then((module) => ({ default: module.AiConfigPage })));

const deferred = (content: ReactNode) => <Suspense fallback={null}>{content}</Suspense>;

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const isWallpaperMode = params.get('wallpaper') === '1';
  const isConsoleMode = params.get('console') === '1';
  const isNotesMode = params.get('notes') === '1';
  const isNoteAppMode = params.get('noteApp') === '1';
  const isElectronNoteAppMode = isNoteAppMode && window.kaoyanDesktop?.isElectron === true;
  const isHubMode = params.get('hub') === '1';
  const isAiConfigMode = params.get('aiConfig') === '1';

  if (isAiConfigMode) {
    return <WebAppShell active="ai-config">{deferred(<AiConfigPage />)}<CommandPalette /></WebAppShell>;
  }

  if (isHubMode) {
    return <WebAppShell active="hub">{deferred(<AppHub />)}<CommandPalette /></WebAppShell>;
  }

  // The drop view is an Electron renderer, not a Web route. Browsers that
  // happen to receive ?noteApp=1 fall through to the normal Web experience.
  if (isElectronNoteAppMode) {
    return deferred(<NoteDropApp />);
  }

  if (isNotesMode) {
    return <WebAppShell active="notes">{deferred(<NoteCapturePage />)}<CommandPalette /></WebAppShell>;
  }

  if (isConsoleMode) {
    return <WebAppShell active="console">{deferred(<DesktopConsole />)}<CommandPalette /></WebAppShell>;
  }

  if (isWallpaperMode) {
    return deferred(<DesktopWorkspace editable={false} />);
  }

  const activeScheduleView = params.get('panel') === 'learning' ? 'learning' : 'schedule';
  return <WebAppShell active={activeScheduleView}>{deferred(<ScheduleApp />)}<CommandPalette /></WebAppShell>;
}
