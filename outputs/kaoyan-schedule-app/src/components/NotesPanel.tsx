import { NotebookPen, TriangleAlert } from 'lucide-react';
import type { DayRecord, RecordField, ScheduleDay } from '../types';

interface NotesPanelProps {
  day: ScheduleDay;
  record: DayRecord;
  onUpdateField: (date: string, field: RecordField, value: string) => void;
}

const fields: Array<{
  field: RecordField;
  title: string;
  placeholder: string;
  icon: typeof NotebookPen;
}> = [
  {
    field: 'note',
    title: '备注',
    placeholder: '当天安排、状态、重点...',
    icon: NotebookPen,
  },
  {
    field: 'debt',
    title: '欠账',
    placeholder: '没完成的内容、需要补的章节...',
    icon: TriangleAlert,
  },
  {
    field: 'mistakes',
    title: '错题提醒',
    placeholder: '需要回看或重做的题...',
    icon: NotebookPen,
  },
];

export function NotesPanel({ day, record, onUpdateField }: NotesPanelProps) {
  return (
    <section className="content-panel notes-panel" aria-label={`${day.date} 学习记录`}>
      <div className="panel-heading">
        <p>当日记录</p>
        <h2>{day.date}</h2>
      </div>

      <div className="notes-stack">
        {fields.map((item) => {
          const Icon = item.icon;
          return (
            <label className="note-field" key={item.field}>
              <span>
                <Icon aria-hidden="true" size={18} />
                {item.title}
              </span>
              <textarea
                value={record[item.field]}
                onChange={(event) => onUpdateField(day.date, item.field, event.target.value)}
                placeholder={item.placeholder}
                rows={6}
              />
            </label>
          );
        })}
      </div>
    </section>
  );
}
