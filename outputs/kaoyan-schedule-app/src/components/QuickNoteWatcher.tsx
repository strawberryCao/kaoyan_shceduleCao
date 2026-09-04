const WATCHER_VARIANT_COUNT = 8;

function watcherVariant(noteUid: string): number {
  let hash = 0;
  for (const character of noteUid) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return hash % WATCHER_VARIANT_COUNT;
}

function WatcherFigure({ variant }: { variant: number }) {
  switch (variant) {
    case 0:
      return (
        <g className="lc-quick-watcher__figure">
          <path className="lc-quick-watcher__body" d="M28.5 44c.3-8.7 1.5-16 5.9-20.9 3.7-4.2 9.2-5.8 17.6-5.3V44Z" />
          <path className="lc-quick-watcher__fold" d="m42.5 18.7 6.4-6 .7 6.2Z" />
          <circle className="lc-quick-watcher__eye" cx="39.4" cy="28.2" r="1.2" />
          <circle className="lc-quick-watcher__eye" cx="46.3" cy="27.3" r="1.2" />
          <path className="lc-quick-watcher__detail" d="M40.8 34.8c2 .7 4 .6 5.8-.4" />
          <path className="lc-quick-watcher__accent" d="M34.2 41.2c1.9-3 4.1-4.4 6.7-4.2-1.1 2.9-3.3 4.3-6.7 4.2Z" />
        </g>
      );
    case 1:
      return (
        <g className="lc-quick-watcher__figure">
          <path className="lc-quick-watcher__body" d="M0 16.5c7.6-1.1 13.1.4 16.4 4.6 3.4 4.2 4.3 11.9 4.1 22.9H0Z" />
          <path className="lc-quick-watcher__fold" d="m8 17.1 6.2-5.6.6 7Z" />
          <circle className="lc-quick-watcher__eye" cx="5.9" cy="27.2" r="1.2" />
          <circle className="lc-quick-watcher__eye" cx="12.6" cy="28.3" r="1.2" />
          <path className="lc-quick-watcher__detail" d="M5.9 34.5c2 .9 4.1 1.1 6.3.4M19.6 37.1c2.1-1 3.6-.6 4.5 1.1" />
          <circle className="lc-quick-watcher__accent" cx="4.4" cy="39.8" r="2.1" />
        </g>
      );
    case 2:
      return (
        <g className="lc-quick-watcher__figure">
          <path className="lc-quick-watcher__body" d="M10.5 44c.8-7.4 4.6-12.1 11.4-14.2 7.6-2.3 15.2-.2 19.8 5.3 1.8 2.2 2.8 5.1 3.1 8.9Z" />
          <path className="lc-quick-watcher__fold" d="m17.4 32 1.8-7.3 5 5.3Z" />
          <path className="lc-quick-watcher__sleep-eye" d="M22.8 37c1.2 1 2.5 1.1 3.8.1M32.2 37.1c1.2.8 2.4.8 3.6-.2" />
          <path className="lc-quick-watcher__detail" d="M28.1 41c1.5.4 2.8.3 4.1-.3" />
          <circle className="lc-quick-watcher__accent" cx="39.7" cy="40.1" r="1.7" />
        </g>
      );
    case 3:
      return (
        <g className="lc-quick-watcher__figure">
          <path className="lc-quick-watcher__body" d="M37.3 44c-1.4-9.8-.7-19.2 2.1-28.4 1.9-6.2 6-8.9 12.6-8.2V44Z" />
          <path className="lc-quick-watcher__fold" d="m43.8 12.5 4-6.7 2.1 5.4Z" />
          <circle className="lc-quick-watcher__eye" cx="44.6" cy="22.8" r="1.2" />
          <circle className="lc-quick-watcher__eye" cx="50.8" cy="21.8" r="1.2" />
          <path className="lc-quick-watcher__detail" d="M44.5 29c1.9.6 3.8.5 5.6-.4M37.9 35.2c-2.1-.2-3.5.6-4.3 2.4" />
          <path className="lc-quick-watcher__accent" d="M46.8 38.5c1.8-1.8 3.5-2.4 5.2-1.7v5.3c-2.2-.2-4-1.4-5.2-3.6Z" />
        </g>
      );
    case 4:
      return (
        <g className="lc-quick-watcher__figure">
          <path className="lc-quick-watcher__body" d="M0 44V28.7c5.6-2.6 10.3-2.7 14.3-.4 4.8 2.7 7.6 7.9 8.4 15.7Z" />
          <path className="lc-quick-watcher__fold" d="m8.3 27.1 1.1-7.2 5.3 7.8Z" />
          <circle className="lc-quick-watcher__eye" cx="7.3" cy="35.1" r="1.25" />
          <circle className="lc-quick-watcher__eye" cx="14.2" cy="34.6" r="1.25" />
          <path className="lc-quick-watcher__detail" d="M8.5 40.2c1.7.5 3.4.5 5 0" />
          <path className="lc-quick-watcher__accent" d="M2.1 31.7c1.6-1.2 3.2-1.5 4.7-.8-1 1.9-2.6 2.7-4.7 2.4Z" />
        </g>
      );
    case 5:
      return (
        <g className="lc-quick-watcher__figure">
          <path className="lc-quick-watcher__body" d="M24 44c.7-7.7 3.2-13.3 7.5-16.8 4.6-3.7 10.5-4.3 17.7-1.8L52 44Z" />
          <path className="lc-quick-watcher__fold" d="m35.2 26.1 3.2-7.3 3.2 6.2Z" />
          <circle className="lc-quick-watcher__eye" cx="35.1" cy="34.2" r="1.2" />
          <circle className="lc-quick-watcher__eye" cx="42" cy="33.6" r="1.2" />
          <path className="lc-quick-watcher__detail" d="M36.7 39.6c1.6.5 3.1.4 4.6-.2M47.8 29.4c1.7-1.2 3.1-1.1 4.2.2" />
          <circle className="lc-quick-watcher__accent" cx="29.6" cy="40.7" r="1.9" />
        </g>
      );
    case 6:
      return (
        <g className="lc-quick-watcher__figure">
          <path className="lc-quick-watcher__body" d="M0 9.6c5.8-.5 10.2 1.1 13.2 4.7 4.6 5.6 5.7 15.5 3.2 29.7H0Z" />
          <path className="lc-quick-watcher__fold" d="m6.9 10.3 5.2-5.5 1.1 8.8Z" />
          <circle className="lc-quick-watcher__eye" cx="5.2" cy="20.8" r="1.2" />
          <circle className="lc-quick-watcher__eye" cx="11.4" cy="21.7" r="1.2" />
          <path className="lc-quick-watcher__detail" d="M5.4 27.3c1.7.7 3.5.8 5.3.3M16.6 32.6c2.1-.4 3.6.3 4.6 1.9" />
          <path className="lc-quick-watcher__accent" d="M3.4 36.7c2.2-1.1 4-.9 5.5.5-1.9 1.5-3.7 1.4-5.5-.5Z" />
        </g>
      );
    default:
      return (
        <g className="lc-quick-watcher__figure">
          <path className="lc-quick-watcher__body" d="M13.2 44c.1-8.9 2.8-15.2 8-19 4.9-3.5 11.1-3.7 18.7-.7 3.9 3.8 6.1 10.4 6.5 19.7Z" />
          <path className="lc-quick-watcher__fold" d="m22 25.1 4-7.2 3.1 6.2Z" />
          <circle className="lc-quick-watcher__eye" cx="25.2" cy="33.4" r="1.2" />
          <circle className="lc-quick-watcher__eye" cx="32.1" cy="32.7" r="1.2" />
          <path className="lc-quick-watcher__detail" d="M26.6 39c1.8.6 3.6.5 5.2-.2M42.4 34.4c2.2-.4 3.7.3 4.5 2" />
          <path className="lc-quick-watcher__accent" d="M17.2 40.7c1.5-2.5 3.3-3.6 5.5-3.4-.8 2.3-2.6 3.5-5.5 3.4Z" />
        </g>
      );
  }
}

export function QuickNoteWatcher({ noteUid }: { noteUid: string }) {
  const variant = watcherVariant(noteUid);

  return (
    <svg
      className={`lc-quick-watcher is-variant-${variant}`}
      viewBox="0 0 52 44"
      preserveAspectRatio="none"
      focusable="false"
      aria-hidden="true"
      data-variant={variant}
    >
      <rect className="lc-quick-watcher__ground" width="52" height="44" rx="10" />
      <path className="lc-quick-watcher__margin" d="M7 0v44M0 35.5h52" />
      <circle className="lc-quick-watcher__speck" cx="45" cy="7.5" r="1" />
      <circle className="lc-quick-watcher__speck" cx="24" cy="12" r=".7" />
      <WatcherFigure variant={variant} />
    </svg>
  );
}
