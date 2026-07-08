import { CalendarDays, Clipboard, LayoutDashboard, Monitor, Settings } from 'lucide-react';

const open = (path: string) => {
  window.open(`${window.location.origin}/${path}`, '_blank', 'noopener,noreferrer');
};

export function AppHub() {
  return (
    <main className="app-hub-page">
      <section className="app-hub-card">
        <header>
          <p>KAOYAN DESKTOP ASSISTANT</p>
          <h1>考研桌面助手</h1>
          <span>一个入口启动全部服务；这里再选择壁纸、控制台、笔记台和完整课表。</span>
        </header>

        <div className="app-hub-grid">
          <button type="button" onClick={() => open('?wallpaper=1')}>
            <Monitor size={24} />
            <strong>壁纸页</strong>
            <span>Lively 使用这个页面作为桌面。</span>
          </button>
          <button type="button" onClick={() => open('?console=1')}>
            <LayoutDashboard size={24} />
            <strong>桌面控制台</strong>
            <span>拖动、缩放、添加组件，实时同步。</span>
          </button>
          <button type="button" onClick={() => open('?notes=1')}>
            <Clipboard size={24} />
            <strong>笔记台</strong>
            <span>稳定拖拽/粘贴图片，画布拼接和画笔。</span>
          </button>
          <button type="button" onClick={() => open('')}>
            <CalendarDays size={24} />
            <strong>完整课表</strong>
            <span>查看 30 天课表、记录和统计。</span>
          </button>
          <button type="button" onClick={() => window.open('http://127.0.0.1:5174/health', '_blank', 'noopener,noreferrer')}>
            <Settings size={24} />
            <strong>服务状态</strong>
            <span>检查笔记保存服务和千问命名。</span>
          </button>
        </div>
      </section>
    </main>
  );
}
