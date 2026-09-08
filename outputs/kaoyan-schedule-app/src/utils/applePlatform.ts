interface NavigatorProfile {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

export const isAppleMobileBrowser = (profile: NavigatorProfile): boolean => {
  const userAgent = String(profile.userAgent || '');
  const platform = String(profile.platform || '');
  return /iPhone|iPad|iPod/i.test(userAgent)
    || (platform === 'MacIntel' && Number(profile.maxTouchPoints || 0) > 1);
};

export const IS_APPLE_MOBILE_BROWSER = typeof navigator !== 'undefined'
  && isAppleMobileBrowser(navigator);
