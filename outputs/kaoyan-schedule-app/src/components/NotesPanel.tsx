import { BookOpenCheck, NotebookPen, Sparkles, TriangleAlert } from 'lucide-react';
import type { DayRecord, RecordField, ScheduleDay } from '../types';
import type { LearningAutoNote } from '../utils/learningData';

interface NotesPanelProps {
  day: ScheduleDay;
  record: DayRecord;
  autoNotes?: LearningAutoNote[];
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

export function NotesPanel({ day, record, autoNotes = [], onUpdateField }: NotesPanelProps) {
  return (
    <section className="content-panel notes-panel" aria-label={`${day.date} 学习记录`}>
      <div className="panel-heading">
        <h2>{day.date} 记录</h2>
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

      {autoNotes.length > 0 && (
        <section className="auto-notes-panel" aria-label={`${day.date} 自动同步笔记`}>
          <header>
            <span><Sparkles aria-hidden="true" size={17} /> 自动同步笔记</span>
            <strong>{autoNotes.length} 条</strong>
          </header>
          <div className="auto-note-list">
            {autoNotes.map((note) => {
              const pageText = note.pageRefs
                .map((item) => item.raw || [item.page ? `p${item.page}` : '', item.question ?? ''].filter(Boolean).join(' '))
                .filter(Boolean)
                .join('、');
              return (
                <article key={note.noteUid} title={note.filePath || note.title}>
                  <div>
                    <BookOpenCheck aria-hidden="true" size={16} />
                    <strong>{note.title || '未命名笔记'}</strong>
                    <em>{note.subject}</em>
                  </div>
                  {note.remark && <p>{note.remark}</p>}
                  {note.items.length > 1 && (
                    <details className="auto-note-items">
                      <summary>画布识别出 {note.items.length} 个内容</summary>
                      <ol>
                        {note.items.map((item, index) => (
                          <li key={`${note.noteUid}-${index}`}>
                            <strong>{item.title || `分项 ${index + 1}`}</strong>
                            <span>{[item.knowledgePoint, item.questionType, item.wrongReason ? `错因：${item.wrongReason}` : ''].filter(Boolean).join(' · ')}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                  {(pageText || note.knowledgePath.length > 0 || note.tags.length > 0) && (
                    <div className="auto-note-meta">
                      {[pageText, note.knowledgePath.join(' / '), note.tags.map((tag) => `#${tag}`).join(' ')]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
}
