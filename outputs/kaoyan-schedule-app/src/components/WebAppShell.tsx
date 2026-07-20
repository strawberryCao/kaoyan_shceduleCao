import { useEffect, useState, type ReactNode } from 'react';
import {
  BookOpenCheck,
  CalendarDays,
  Clipboard,
  Home,
  PanelsTopLeft,
  LayoutDashboard,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
} from 'lucide-react';
import { openNoteCaptureApp } from './NoteDock';

export type WebAppDestination = 'hub' | 'schedule' | 'learning' | 'notes' | 'console';

interface WebAppShellProps {
  active: WebAppDestination;
  children: ReactNode;
}

const COLLAPSE_KEY = 'kaoyan-web-nav-collapsed-v1';

const go = (path: string) => {
  window.location.assign(`${window.location.origin}/${path}`);
};

const mainItems = [
  { id: 'hub' as const, label: '首页', icon: Home, action: () => go('?hub=1') },
  { id: 'schedule' as const, label: '今日课表', icon: CalendarDays, action: () => go('') },
  { id: 'learning' as const, label: '学习中心', icon: BookOpenCheck, action: () => go('?panel=learning') },
  { id: 'notes' as const, label: '画布', icon: PanelsTopLeft, action: () => go('?notes=1&mode=canvas') },
  { id: 'console' as const, label: '桌面控制台', icon: LayoutDashboard, action: () => go('?console=1') },
];

export function WebAppShell({ active, children }: WebAppShellProps) {
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem(COLLAPSE_KEY) === '1');

  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const openSearch = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
  };

  return (
    <div className={`${collapsed || active === 'notes' ? 'web-app-frame is-collapsed' : 'web-app-frame'}${active === 'notes' ? ' is-canvas-active' : ''}`}>
      <aside className="web-app-nav" aria-label="全局导航">
        <button className="web-app-brand" type="button" onClick={() => go('?hub=1')} title="考研桌面助手">
          <span>研</span>
          <strong>考研助手</strong>
        </button>

        <nav className="web-app-main-nav">
          {mainItems.map((item) => {
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
              </button>
            );
          })}
        </nav>

        <div className="web-app-nav-tools">
          <button type="button" onClick={() => void openNoteCaptureApp()} title="快速记图">
            <Clipboard aria-hidden="true" size={20} />
            <span>快速记图</span>
          </button>
          <button type="button" onClick={openSearch} title="搜索与快捷操作">
            <Search aria-hidden="true" size={20} />
            <span>搜索</span>
            <kbd>Ctrl K</kbd>
          </button>
          <button type="button" onClick={() => window.open(`${window.location.origin}/?wallpaper=1`, '_blank', 'noopener,noreferrer')} title="打开壁纸页">
            <Monitor aria-hidden="true" size={20} />
            <span>壁纸页</span>
          </button>
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

      <nav className="web-app-mobile-nav" aria-label="移动端导航">
        {mainItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              aria-current={active === item.id ? 'page' : undefined}
              className={active === item.id ? 'is-active' : ''}
              key={item.id}
              type="button"
              onClick={item.action}
            >
              <Icon aria-hidden="true" size={20} />
              <span>{item.label === '今日课表' ? '课表' : item.label === '学习中心' ? '学习' : item.label === '桌面控制台' ? '控制台' : item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
