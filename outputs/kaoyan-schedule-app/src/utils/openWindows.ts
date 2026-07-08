const WINDOW_FEATURES = 'noopener,noreferrer,width=1280,height=860,left=80,top=60';

export const openAppWindow = (pathWithQuery: string, windowName: string) => {
  const url = `${window.location.origin}/${pathWithQuery.replace(/^\//, '')}`;
  const opened = window.open(url, windowName, WINDOW_FEATURES);
  opened?.focus();
};

export const openNoteCaptureWindow = () => {
  openAppWindow('?notes=1', 'kaoyan_note_capture');
};
