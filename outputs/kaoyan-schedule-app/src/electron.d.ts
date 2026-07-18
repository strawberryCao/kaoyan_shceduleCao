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
      minimize: () => void;
      hide: () => void;
      close: () => void;
    };
  }
}
