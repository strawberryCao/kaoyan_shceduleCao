import { ScheduleApp } from './components/ScheduleApp';
import { DesktopConsole } from './desktop/DesktopConsole';
import { DesktopWorkspace } from './desktop/DesktopWorkspace';
import './wallpaper.css';
import './notes.css';
import './theme-fifth.css';
import './desktop/desktop.css';

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const isWallpaperMode = params.get('wallpaper') === '1';
  const isConsoleMode = params.get('console') === '1';

  if (isConsoleMode) {
    return <DesktopConsole />;
  }

  if (isWallpaperMode) {
    return <DesktopWorkspace editable={false} />;
  }

  return <ScheduleApp />;
}
