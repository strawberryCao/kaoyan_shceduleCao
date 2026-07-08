import { ScheduleApp } from './components/ScheduleApp';
import { WallpaperView } from './components/WallpaperView';
import './wallpaper.css';
import './notes.css';
import './theme-fifth.css';

export default function App() {
  const isWallpaperMode = new URLSearchParams(window.location.search).get('wallpaper') === '1';

  return isWallpaperMode ? <WallpaperView /> : <ScheduleApp />;
}
