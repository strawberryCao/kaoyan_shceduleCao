import { useEffect, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import {
  WorkspaceAssetPreview,
  type WorkspaceAssetPreviewItem,
} from './WorkspaceAssetPreview';
import '../material-float-window.css';

type MaterialDescriptor = {
  item: WorkspaceAssetPreviewItem;
  assets: WorkspaceAssetPreviewItem[];
};

export function MaterialFloatWindow() {
  const [descriptor, setDescriptor] = useState<MaterialDescriptor | null>(null);

  useEffect(() => {
    void window.kaoyanDesktop?.getMaterialWindowDescriptor().then(setDescriptor);
  }, []);

  if (!descriptor) return <main className="material-float-shell is-loading">正在打开资料…</main>;

  return (
    <main className={`material-float-shell is-${descriptor.item.kind}`}>
      <header className="material-float-handle">
        <strong>{descriptor.item.name}</strong>
        <button
          type="button"
          aria-label="全屏或退出全屏"
          onClick={() => void window.kaoyanDesktop?.toggleMaterialWindowFullscreen()}
        >
          <Maximize2 size={13} />
        </button>
        <button
          type="button"
          aria-label="收回资料"
          onClick={() => void window.kaoyanDesktop?.closeMaterialWindow()}
        >
          <X size={14} />
        </button>
      </header>
      <section>
        <WorkspaceAssetPreview
          item={descriptor.item}
          assets={descriptor.assets}
          onRecovered={() => undefined}
          onIntrinsicSize={(width, height) => {
            if (descriptor.item.kind !== 'image') return;
            const ratio = Math.max(.22, Math.min(4.5, width / height));
            const fittedWidth = ratio >= 1 ? Math.min(960, Math.max(380, width)) : Math.min(700, Math.max(300, width));
            const fittedHeight = Math.round(fittedWidth / ratio) + 30;
            void window.kaoyanDesktop?.fitMaterialWindow(fittedWidth, fittedHeight);
          }}
        />
      </section>
    </main>
  );
}
