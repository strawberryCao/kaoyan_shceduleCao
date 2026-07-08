import { Clipboard, ExternalLink } from 'lucide-react';
import { openNoteCaptureWindow } from '../utils/openWindows';

export function NoteDock() {
  return (
    <section
      className="note-dock note-dock-launcher"
      onClick={openNoteCaptureWindow}
      tabIndex={0}
      aria-label="打开笔记台"
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openNoteCaptureWindow();
        }
      }}
    >
      <div className="note-dock-main">
        <span className="note-dock-icon"><Clipboard size={16} aria-hidden="true" /></span>
        <div>
          <p>笔记台</p>
          <span>点击打开已有笔记台；没有则新建</span>
        </div>
      </div>
      <button
        className="note-canvas-button"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openNoteCaptureWindow();
        }}
        title="打开笔记台"
      >
        <ExternalLink size={15} aria-hidden="true" />
      </button>
    </section>
  );
}
