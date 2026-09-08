import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import {
  BookOpenCheck,
  BrainCircuit,
  CalendarDays,
  Camera,
  Home,
  PanelsTopLeft,
  LayoutDashboard,
  LogOut,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Inbox,
  Library,
} from 'lucide-react';
import { IS_CLOUD_RUNTIME } from '../utils/runtime';
import { navigateApp } from '../utils/appNavigation';
import type { ActivityTaskSummary } from '../utils/activityTasks';

export type WebAppDestination = 'hub' | 'schedule' | 'learning' | 'activity' | 'notes' | 'console' | 'ai-config';

interface WebAppShellProps {
  active: WebAppDestination;
  children: ReactNode;
}

const COLLAPSE_KEY = 'kaoyan-web-nav-collapsed-v1';
const LearningRenameAction = lazy(() => import('./LearningRenameAction').then((module) => ({ default: module.LearningRenameAction })));

const go = (path: string) => {
  navigateApp(path);
};

const primaryItems = [
  { id: 'hub' as const, label: '今天', icon: Home, action: () => go('?hub=1') },
  { id: 'notes' as const, label: '画布', icon: PanelsTopLeft, action: () => go('?notes=1&mode=canvas'), emphasis: true },
  { id: 'schedule' as const, label: '学习计划', icon: CalendarDays, action: () => go('') },
  { id: 'learning' as const, label: '复习与资料', icon: BookOpenCheck, action: () => go('?panel=learning') },
];

const workspaceItems = [
  { id: 'activity' as const, label: '任务动态', icon: Inbox, action: () => go('?activity=1') },
  { id: 'console' as const, label: '桌面控制台', icon: LayoutDashboard, action: () => go('?console=1') },
  { id: 'ai-config' as const, label: 'AI 自动化', icon: BrainCircuit, action: () => go('?aiConfig=1') },
];

export function WebAppShell({ active, children }: WebAppShellProps) {
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem(COLLAPSE_KEY) === '1');
  const [activity, setActivity] = useState<ActivityTaskSummary>({ failed: 0, needsReview: 0, active: 0 });
  const [captureFeedback, setCaptureFeedback] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [remoteConnection, setRemoteConnection] = useState<{ checking: boolean; online: boolean; access: string }>({ checking: true, online: false, access: '' });
  const visibleWorkspaceItems = IS_CLOUD_RUNTIME
    ? workspaceItems.filter((item) => item.id !== 'console' && item.id !== 'ai-config')
    : workspaceItems;
  const locationParams = new URLSearchParams(window.location.search);
  const learningView = locationParams.has('q') ? 'library' : locationParams.get('view') || 'review';

  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  useEffect(() => {
    let dispose: () => void = () => undefined;
    let activeEffect = true;
    void import('../utils/activityTasks').then(({ getActivityTaskSummary, subscribeActivityTasks }) => {
      const refresh = () => void getActivityTaskSummary().then((summary) => {
        if (activeEffect) setActivity(summary);
      }).catch(() => undefined);
      refresh();
      dispose = subscribeActivityTasks(refresh);
    });
    return () => { activeEffect = false; dispose(); };
  }, []);

  useEffect(() => {
    if (!captureFeedback) return undefined;
    const timer = window.setTimeout(() => setCaptureFeedback(''), 3200);
    return () => window.clearTimeout(timer);
  }, [captureFeedback]);

  useEffect(() => {
    if (!IS_CLOUD_RUNTIME) return undefined;
    let disposed = false;
    const refresh = async () => {
      try {
        const [readyResponse, authResponse] = await Promise.all([
          fetch('/readyz', { cache: 'no-store', credentials: 'same-origin' }),
          fetch('/api/auth/status', { cache: 'no-store', credentials: 'same-origin' }),
        ]);
        const auth = await authResponse.json().catch(() => ({})) as { access?: string; authenticated?: boolean };
        if (authResponse.ok && auth.authenticated === false) {
          window.location.reload();
          return;
        }
        if (!disposed) setRemoteConnection({ checking: false, online: readyResponse.ok, access: String(auth.access || '') });
      } catch {
        if (!disposed) setRemoteConnection((current) => ({ ...current, checking: false, online: false }));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);

  const openCapture = async () => {
    setCaptureFeedback('正在打开速记…');
    try {
      const { openNoteCaptureApp } = await import('./NoteDock');
      const opened = await openNoteCaptureApp();
      setCaptureFeedback(opened ? '速记已打开，可以直接拖入或粘贴资料' : '速记没有打开，请检查桌面助手是否正在运行');
    } catch {
      setCaptureFeedback('速记没有打开，请稍后重试');
    }
  };

  const openSearch = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
  };

  const logoutRemoteSession = async () => {
    if (loggingOut) return;
    if (!window.confirm('退出这台设备上的登录？尚未送达 Mac 的加密速记会保留。')) return;
    try {
      setLoggingOut(true);
      setCaptureFeedback('正在安全退出…');
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`退出服务返回 ${response.status}`);
      window.location.reload();
    } catch (cause) {
      setCaptureFeedback(cause instanceof Error ? cause.message : '暂时无法退出，请稍后重试');
      setLoggingOut(false);
    }
  };

  return (
    <div className={`${IS_CLOUD_RUNTIME ? 'is-cloud-runtime ' : ''}${collapsed || active === 'notes' ? 'web-app-frame is-collapsed' : 'web-app-frame'}${active === 'notes' ? ' is-canvas-active' : ''}`}>
      <aside className="web-app-nav" aria-label="全局导航">
        <button className="web-app-brand" type="button" onClick={() => go('?hub=1')} title="考研桌面助手">
          <span>研</span>
          <strong>考研助手</strong>
        </button>

        <nav className="web-app-main-nav">
          <span className="web-app-nav-section">学习主线</span>
          {primaryItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                aria-current={active === item.id ? 'page' : undefined}
                className={`${active === item.id ? 'is-active ' : ''}${item.emphasis ? 'is-canvas-entry' : ''}`}
                key={item.id}
                title={item.label}
                type="button"
                onClick={item.action}
              >
                <Icon aria-hidden="true" size={20} />
                <span>{item.label}</span>
              </button>
            );
          })}
          <span className="web-app-nav-section is-workspace">工作台</span>
          {visibleWorkspaceItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                aria-current={active === item.id ? 'page' : undefined}
                className={active === item.id ? 'is-active' : ''}
                key={item.id}
                title={item.label}
                type="button"
                onClick={item.action}
              >
                <Icon aria-hidden="true" size={20} />
                <span>{item.label}</span>
                {item.id === 'activity' && activity.failed + activity.needsReview > 0 && <b className="web-app-task-badge">{activity.failed + activity.needsReview}</b>}
              </button>
            );
          })}
        </nav>

        <div className="web-app-nav-tools">
          <button className="web-app-capture-action" type="button" onClick={() => void openCapture()} title="新建速记">
            <Camera aria-hidden="true" size={20} />
            <span>新建速记</span>
          </button>
          <button type="button" onClick={openSearch} title="搜索与快捷操作">
            <Search aria-hidden="true" size={20} />
            <span>搜索</span>
            <kbd>Ctrl K</kbd>
          </button>
          {window.kaoyanDesktop?.isElectron && (
            <button type="button" onClick={() => window.open(`${window.location.origin}/?wallpaper=1`, '_blank', 'noopener,noreferrer')} title="打开壁纸页">
              <Monitor aria-hidden="true" size={20} />
              <span>壁纸页</span>
            </button>
          )}
          {IS_CLOUD_RUNTIME && (
            <button type="button" onClick={() => void logoutRemoteSession()} disabled={loggingOut} title="退出这台设备">
              <LogOut aria-hidden="true" size={20} />
              <span>{loggingOut ? '正在退出…' : '安全退出'}</span>
            </button>
          )}
        </div>

        <button
          aria-label={collapsed ? '展开导航' : '收起导航'}
          className="web-app-collapse"
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? '展开导航' : '收起导航'}
        >
          {collapsed ? <PanelLeftOpen aria-hidden="true" size={20} /> : <PanelLeftClose aria-hidden="true" size={20} />}
          <span>{collapsed ? '展开导航' : '收起导航'}</span>
        </button>
      </aside>

      <div className="web-app-content">{children}</div>
      {IS_CLOUD_RUNTIME && active === 'hub' && (
        <button
          className={`web-app-mobile-connection${remoteConnection.checking ? ' is-checking' : remoteConnection.online ? '' : ' is-offline'}`}
          type="button"
          onClick={() => go('?activity=1')}
          aria-label={remoteConnection.checking ? '正在连接 Mac mini' : remoteConnection.online ? 'Mac mini 已连接，打开任务动态' : 'Mac mini 连接异常，打开任务动态'}
        >
          <span aria-hidden="true" />
          {remoteConnection.checking
            ? 'Mac · 正在连接'
            : remoteConnection.online
            ? remoteConnection.access === 'cloudflare-fallback' ? 'Mac · 备用入口' : 'Mac · 私有直连'
            : 'Mac · 连接异常'}
        </button>
      )}
      {IS_CLOUD_RUNTIME && (
        <button
          aria-label={loggingOut ? '正在退出' : '退出这台设备'}
          className="web-app-mobile-logout"
          type="button"
          disabled={loggingOut}
          onClick={() => void logoutRemoteSession()}
          title="安全退出"
        >
          <LogOut aria-hidden="true" size={18} />
          <span>{loggingOut ? '退出中' : '退出'}</span>
        </button>
      )}
      {active === 'learning' && <Suspense fallback={null}><LearningRenameAction /></Suspense>}
      {captureFeedback && <div className="web-app-feedback" role="status" aria-live="polite">{captureFeedback}</div>}

      <nav className="web-app-mobile-nav" aria-label="移动端导航">
        {[
          { key: 'today', label: '今天', icon: Home, action: () => go('?hub=1'), active: active === 'hub' || active === 'schedule' },
          { key: 'canvas', label: '画布', icon: PanelsTopLeft, action: () => go('?notes=1&mode=canvas'), active: active === 'notes' },
          { key: 'capture', label: '捕获', icon: Camera, action: () => void openCapture(), active: false },
          { key: 'review', label: '复习', icon: BookOpenCheck, action: () => go('?panel=learning&view=review'), active: active === 'learning' && learningView === 'review' },
          { key: 'library', label: '资料', icon: Library, action: () => go('?panel=learning&view=library'), active: active === 'learning' && learningView !== 'review' },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <button
              aria-current={item.active ? 'page' : undefined}
              aria-label={item.key === 'capture' ? '打开速记捕获' : undefined}
              className={`${item.active ? 'is-active ' : ''}${item.key === 'capture' ? 'is-capture' : ''}`}
              key={item.key}
              type="button"
              onClick={item.action}
            >
              <Icon aria-hidden="true" size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
