export {};

declare global {
  interface Window {
    kaoyanDesktop?: {
      platform: string;
      isElectron: boolean;
      getAutoLaunch: () => Promise<boolean>;
      setAutoLaunch: (enabled: boolean) => Promise<boolean>;
      restoreDefaultPosition: () => Promise<unknown>;
      savePosition: () => Promise<unknown>;
      openNoteApp: () => Promise<boolean>;
      closeNoteApp: () => Promise<boolean>;
      setNoteAppDirty: (dirty: boolean, saving: boolean) => Promise<boolean>;
      setNoteAppMode: (mode: 'compact' | 'remark') => Promise<boolean>;
      openNoteCanvas: () => Promise<boolean>;
      showItemInFolder: (filePath: string) => Promise<boolean>;
      openPath: (filePath: string) => Promise<boolean>;
      openMaterialWindow: (descriptor: Record<string, unknown>) => Promise<boolean>;
      getMaterialWindowDescriptor: () => Promise<{
        item: import('./components/WorkspaceAssetPreview').WorkspaceAssetPreviewItem;
        assets: import('./components/WorkspaceAssetPreview').WorkspaceAssetPreviewItem[];
      } | null>;
      toggleMaterialWindowFullscreen: () => Promise<boolean>;
      fitMaterialWindow: (width: number, height: number) => Promise<boolean>;
      closeMaterialWindow: () => Promise<boolean>;
      minimize: () => void;
      hide: () => void;
      close: () => void;
    };
  }
}
