import { AppHub } from './components/AppHub';
import { CommandPalette } from './components/CommandPalette';
import { ScheduleApp } from './components/ScheduleApp';
import { WebAppShell } from './components/WebAppShell';
import { NoteCapturePage } from './components/NoteCapturePage';
import { NoteDropApp } from './components/NoteDropApp';
import { DesktopConsole } from './desktop/DesktopConsole';
import { DesktopWorkspace } from './desktop/DesktopWorkspace';
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

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const isWallpaperMode = params.get('wallpaper') === '1';
  const isConsoleMode = params.get('console') === '1';
  const isNotesMode = params.get('notes') === '1';
  const isNoteAppMode = params.get('noteApp') === '1';
  const isElectronNoteAppMode = isNoteAppMode && window.kaoyanDesktop?.isElectron === true;
  const isHubMode = params.get('hub') === '1';

  if (isHubMode) {
    return <WebAppShell active="hub"><AppHub /><CommandPalette /></WebAppShell>;
  }

  // The drop view is an Electron renderer, not a Web route. Browsers that
  // happen to receive ?noteApp=1 fall through to the normal Web experience.
  if (isElectronNoteAppMode) {
    return <NoteDropApp />;
  }

  if (isNotesMode) {
    return <WebAppShell active="notes"><NoteCapturePage /><CommandPalette /></WebAppShell>;
  }

  if (isConsoleMode) {
    return <WebAppShell active="console"><DesktopConsole /><CommandPalette /></WebAppShell>;
  }

  if (isWallpaperMode) {
    return <DesktopWorkspace editable={false} />;
  }

  const activeScheduleView = params.get('panel') === 'learning' ? 'learning' : 'schedule';
  return <WebAppShell active={activeScheduleView}><ScheduleApp /><CommandPalette /></WebAppShell>;
}
