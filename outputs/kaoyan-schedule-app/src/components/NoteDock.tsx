import { Clipboard, ExternalLink } from 'lucide-react';

export function NoteDock() {
  const openNoteCapture = () => {
    window.open(`${window.location.origin}/?notes=1`, '_blank', 'noopener,noreferrer');
  };

  return (
    <section
      className="note-dock note-dock-launcher"
      onClick={openNoteCapture}
      tabIndex={0}
      aria-label="打开笔记台"
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openNoteCapture();
        }
      }}
    >
      <div className="note-dock-main">
        <span className="note-dock-icon"><Clipboard size={16} aria-hidden="true" /></span>
        <div>
          <p>笔记台</p>
          <span>Lively 内拖拽不稳定，点击到网页保存</span>
        </div>
      </div>
      <button
        className="note-canvas-button"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openNoteCapture();
        }}
        title="打开笔记台"
      >
        <ExternalLink size={15} aria-hidden="true" />
      </button>
    </section>
  );
}
