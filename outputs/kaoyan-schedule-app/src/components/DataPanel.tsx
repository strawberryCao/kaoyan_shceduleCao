import { Download, Trash2, Upload } from 'lucide-react';

interface DataPanelProps {
  onExport: () => void;
  onImportClick: () => void;
  onClear: () => void;
}

export function DataPanel({ onExport, onImportClick, onClear }: DataPanelProps) {
  return (
    <section className="content-panel data-panel" aria-label="数据管理">
      <div className="panel-heading">
        <h2>备份和恢复</h2>
      </div>

      <div className="data-actions">
        <button className="large-action" type="button" onClick={onExport}>
          <Download aria-hidden="true" size={22} />
          <span className="data-action-copy">
            <strong>导出 JSON</strong>
            <span className="data-action-description">保存当前完成状态、备注、欠账和错题提醒。</span>
          </span>
        </button>

        <button className="large-action" type="button" onClick={onImportClick}>
          <Upload aria-hidden="true" size={22} />
          <span className="data-action-copy">
            <strong>导入 JSON</strong>
            <span className="data-action-description">从之前导出的记录恢复学习进度。</span>
          </span>
        </button>

        <button className="large-action danger" type="button" onClick={onClear}>
          <Trash2 aria-hidden="true" size={22} />
          <span className="data-action-copy">
            <strong>清空记录</strong>
            <span className="data-action-description">清空前会弹窗确认，操作不可撤销。</span>
          </span>
        </button>
      </div>
    </section>
  );
}
