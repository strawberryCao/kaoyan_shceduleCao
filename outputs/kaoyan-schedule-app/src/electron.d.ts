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
      attachToDesktop: () => Promise<boolean>;
      minimize: () => void;
      hide: () => void;
      close: () => void;
    };
  }
}
