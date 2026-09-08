import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileUp,
  GitMerge,
  Inbox,
  RefreshCw,
  RotateCcw,
  Server,
  Sparkles,
  StopCircle,
  Undo2,
} from 'lucide-react';
import {
  activitySummary,
  activityTaskNoteUid,
  listActivityTasks,
  patchActivityTask,
  subscribeActivityTasks,
  type ActivityTask,
  type ActivityTaskStatus,
} from '../utils/activityTasks';
import { navigateApp, openAppTarget } from '../utils/appNavigation';
import { cancelCaptureUpload, retryCaptureUpload } from '../utils/captureUploadQueue';
import { cancelMultiQuestionJob, retryMultiQuestionJob } from '../utils/noteBackgroundJobs';
import {
  enqueueLearningNoteRename,
  fetchAuthorityAiTasks,
  fetchSyncConflicts,
  getAiBackgroundJob,
  resolveSyncConflict,
  retryAuthorityAiTask,
  undoSyncConflict,
  type AuthorityAiQueueStatus,
  type AuthorityAiTask,
  type SyncConflictRecord,
} from '../utils/notes';
import { fetchLearningData } from '../utils/learningData';
import { learningNoteTarget, learningTargetViewFromUrl } from '../utils/learningNavigation';
import '../activity-center.css';

const statusMeta: Record<ActivityTaskStatus, { label: string; tone: string }> = {
  local_saved: { label: '已存本机', tone: 'neutral' }, queued: { label: '等待处理', tone: 'neutral' },
  uploading: { label: '正在上传', tone: 'active' }, processing: { label: 'AI 处理中', tone: 'active' },
  needs_review: { label: '待确认', tone: 'warning' }, completed: { label: '已完成', tone: 'success' },
  failed_retryable: { label: '可重试', tone: 'danger' }, failed_terminal: { label: '需要处理', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'muted' },
};

const kindLabel = (task: ActivityTask) => ({
  capture_upload: '拍题保存', question_crop: 'AI 自动裁题', material_append: '速记附件',
  ai_rename: 'AI 命名', classification: 'AI 分类', canvas_organization: '画布整理',
}[task.kind]);

const taskIcon = (task: ActivityTask) => {
  if (task.kind === 'capture_upload') return <FileUp size={20} />;
  if (task.kind === 'question_crop') return <Camera size={20} />;
  return <Sparkles size={20} />;
};

const authorityStatus = (status: AuthorityAiTask['status']) => ({
  queued: { label: '等待 Mac', tone: 'neutral' },
  processing: { label: 'Mac 处理中', tone: 'active' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '等待你重试', tone: 'danger' },
  needs_review: { label: '结果不确定', tone: 'warning' },
  skipped: { label: '无需处理', tone: 'muted' },
}[status] || { label: status, tone: 'neutral' });

const authorityTaskLabel = (task: AuthorityAiTask): string => ({
  'note-naming': '图片笔记理解与命名',
  'learning-note-rename': '学习笔记重新命名',
  'material-naming': '速记与资料命名',
}[task.type] || 'Mac AI 任务');

const conflictFieldLabel = (field: string): string => ({
  title: '标题', remark: '备注', subject: '学科', document: '内容', status: '状态', deleted: '删除状态',
}[field] || field);

const formatConflictValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '空白';
  if (typeof value === 'string') return value.length > 220 ? `${value.slice(0, 220)}…` : value;
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized.length > 420 ? `${serialized.slice(0, 420)}…` : serialized;
  } catch {
    return String(value);
  }
};

export function ActivityCenter() {
  const [tasks, setTasks] = useState<ActivityTask[]>([]);
  const [authorityJobs, setAuthorityJobs] = useState<AuthorityAiTask[]>([]);
  const [queueStatus, setQueueStatus] = useState<AuthorityAiQueueStatus | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflictRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [actionError, setActionError] = useState('');

  const refresh = async () => {
    const authorityState = Promise.allSettled([
      fetchAuthorityAiTasks(),
      fetchSyncConflicts(true),
    ]);
    try {
      let nextTasks = await listActivityTasks();
      const staleFailures = nextTasks.filter((task) => task.kind === 'ai_rename'
        && ['failed_retryable', 'failed_terminal'].includes(task.status));
      if (staleFailures.length > 0) {
        const snapshot = await fetchLearningData();
        const notesByUid = new Map(Object.values(snapshot.days || {})
          .flatMap((day) => Array.isArray(day.autoNotes) ? day.autoNotes : [])
          .map((note) => [note.noteUid, note]));
        for (const task of staleFailures) {
          const noteUid = activityTaskNoteUid(task);
          const note = notesByUid.get(noteUid);
          const requestedTitle = task.title.replace(/^AI 命名[：:]\s*/u, '').trim();
          if (!note?.title || note.title === requestedTitle) continue;
          await patchActivityTask(task.id, {
            status: 'completed', progress: 100, canRetry: false, canCancel: false,
            title: `AI 命名：${note.title}`,
            message: '记录已完成命名，旧失败状态已自动校正',
            error: '', resultNoteUids: [noteUid], completedAt: note.updatedAt || new Date().toISOString(),
          });
        }
        nextTasks = await listActivityTasks();
      }
      setTasks(nextTasks);
    } finally {
      const [aiResult, conflictResult] = await authorityState;
      if (aiResult.status === 'fulfilled') {
        setAuthorityJobs(aiResult.value.jobs);
        setQueueStatus(aiResult.value.queue);
      } else {
        setAuthorityJobs([]);
        setQueueStatus(null);
      }
      setConflicts(conflictResult.status === 'fulfilled' ? conflictResult.value : []);
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    return subscribeActivityTasks(() => void refresh());
  }, []);

  const summary = useMemo(() => activitySummary(tasks), [tasks]);
  const visibleAuthorityJobs = useMemo(() => authorityJobs.slice(0, 24), [authorityJobs]);
  const visibleConflicts = useMemo(() => conflicts
    .filter((conflict) => conflict.status === 'open' || conflict.canUndo)
    .slice(0, 16), [conflicts]);
  const activeCount = summary.active + authorityJobs.filter((job) => ['queued', 'processing'].includes(job.status)).length;
  const failedCount = summary.failed + authorityJobs.filter((job) => job.status === 'failed').length;
  const reviewCount = summary.needsReview
    + authorityJobs.filter((job) => job.status === 'needs_review').length
    + conflicts.filter((conflict) => conflict.status === 'open').length;

  const retryMacTask = async (task: AuthorityAiTask) => {
    setBusyId(`mac:${task.id}`);
    setActionError('');
    try {
      await retryAuthorityAiTask(task.id);
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Mac AI 任务未能重试。');
    } finally {
      setBusyId('');
    }
  };

  const chooseConflict = async (conflict: SyncConflictRecord, choice: 'current' | 'incoming') => {
    setBusyId(`conflict:${conflict.id}`);
    setActionError('');
    try {
      await resolveSyncConflict(conflict.id, choice);
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '没有完成冲突选择，请刷新后再试。');
    } finally {
      setBusyId('');
    }
  };

  const undoConflict = async (conflict: SyncConflictRecord) => {
    setBusyId(`conflict:${conflict.id}`);
    setActionError('');
    try {
      await undoSyncConflict(conflict.id);
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '无法撤销；这条记录可能已经有了更新。');
    } finally {
      setBusyId('');
    }
  };

  const retry = async (task: ActivityTask) => {
    setBusyId(task.id);
    try {
      if (task.kind === 'capture_upload') await retryCaptureUpload(task.sourceId);
      else if (task.kind === 'question_crop') await retryMultiQuestionJob(task.sourceId);
      else if (task.kind === 'ai_rename') {
        const targetNoteUid = activityTaskNoteUid(task) || task.sourceId;
        const queued = await enqueueLearningNoteRename(targetNoteUid);
        const replacementId = `ai-rename:${targetNoteUid}`;
        await patchActivityTask(task.id, {
          status: 'cancelled', canRetry: false, canCancel: false,
          message: '已重新提交，后续进度见新的 AI 命名任务', completedAt: new Date().toISOString(),
        });
        const { createActivityTask, upsertActivityTask } = await import('../utils/activityTasks');
        await upsertActivityTask(createActivityTask({
          id: replacementId,
          sourceId: targetNoteUid,
          kind: 'ai_rename',
          status: queued.job.status === 'processing' ? 'processing' : 'queued',
          title: task.title,
          message: queued.job.message,
          progress: queued.job.progress,
          targetUrl: task.targetUrl,
          canRetry: false,
          canCancel: true,
        }));
        void (async () => {
          let job = queued.job;
          try {
            for (let attempt = 0; attempt < 120 && ['queued', 'processing'].includes(job.status); attempt += 1) {
              await new Promise((resolve) => window.setTimeout(resolve, 1500));
              job = await getAiBackgroundJob(job.id);
              await patchActivityTask(replacementId, {
                status: job.status === 'processing' ? 'processing'
                  : job.status === 'needs_review' ? 'needs_review'
                  : job.status === 'failed' ? 'failed_retryable'
                    : job.status === 'completed' || job.status === 'skipped' ? 'completed' : 'queued',
                progress: job.progress,
                message: job.message,
                error: job.error,
                provider: job.result?.provider || '',
                model: job.result?.model || '',
                resultNoteUids: job.status === 'completed' ? [targetNoteUid] : [],
                canRetry: job.status === 'failed',
                canCancel: ['queued', 'processing'].includes(job.status),
                completedAt: job.completedAt,
              });
            }
          } catch (error) {
            await patchActivityTask(replacementId, {
              status: 'failed_retryable', canRetry: true, canCancel: false,
              error: error instanceof Error ? error.message : String(error),
              message: 'AI 命名状态读取失败，可以安全重试',
            });
          }
        })();
      }
      else if (task.targetUrl) openAppTarget(task.targetUrl);
    } catch (error) {
      await patchActivityTask(task.id, {
        status: 'failed_retryable',
        error: error instanceof Error ? error.message : String(error),
        message: '重试没有启动，任务内容仍安全保留。',
      });
    } finally { setBusyId(''); }
  };

  const cancel = async (task: ActivityTask) => {
    setBusyId(task.id);
    try {
      if (task.kind === 'capture_upload') await cancelCaptureUpload(task.sourceId);
      else if (task.kind === 'question_crop') await cancelMultiQuestionJob(task.sourceId);
      else await patchActivityTask(task.id, { status: 'cancelled', canCancel: false, completedAt: new Date().toISOString() });
    } finally { setBusyId(''); }
  };

  const openTask = async (task: ActivityTask) => {
    const noteUid = activityTaskNoteUid(task);
    if (!noteUid) {
      if (task.targetUrl) openAppTarget(task.targetUrl);
      return;
    }
    setBusyId(task.id);
    try {
      const snapshot = await fetchLearningData();
      const note = Object.values(snapshot.days || {})
        .flatMap((day) => Array.isArray(day.autoNotes) ? day.autoNotes : [])
        .find((candidate) => candidate.noteUid === noteUid);
      // Use the latest record facets instead of the stale view stored when the
      // task was created. The note UID remains the source of truth.
      navigateApp(learningNoteTarget(noteUid, note, learningTargetViewFromUrl(task.targetUrl)));
    } catch {
      // Preserve the last known view while offline. The URL-side resolver keeps
      // noteUid pending and therefore never opens the first unrelated record.
      const preferredView = learningTargetViewFromUrl(task.targetUrl);
      navigateApp(learningNoteTarget(noteUid, undefined, preferredView));
    } finally {
      setBusyId('');
    }
  };

  return (
    <main className="activity-center">
      <header className="activity-header">
        <div>
          <span className="activity-eyebrow"><Inbox size={15} />可信收件箱</span>
          <h1>活动中心</h1>
          <p>拍题、裁题、附件和 AI 任务都在这里留下可恢复记录。</p>
        </div>
        <button type="button" onClick={() => void refresh()}><RefreshCw size={16} />刷新</button>
      </header>

      <section className="activity-summary" aria-label="任务概览">
        <div><Clock3 size={18} /><strong>{activeCount}</strong><span>处理中</span></div>
        <div><AlertTriangle size={18} /><strong>{failedCount}</strong><span>需要处理</span></div>
        <button type="button" onClick={() => document.querySelector('.authority-conflicts')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
          <Inbox size={18} /><strong>{reviewCount}</strong><span>待确认</span><ChevronRight size={16} />
        </button>
      </section>

      {actionError && <p className="activity-action-error" role="alert">{actionError}</p>}

      {visibleConflicts.length > 0 && (
        <section className="authority-section authority-conflicts" aria-labelledby="conflict-heading">
          <header><span><GitMerge size={18} /><strong id="conflict-heading">数据版本选择</strong></span><small>只在两个设备改了同一处时出现；你的选择可以立即撤销</small></header>
          <div className="conflict-grid">
            {visibleConflicts.map((conflict) => {
              const busy = busyId === `conflict:${conflict.id}`;
              return (
                <article className={`conflict-card${conflict.status === 'resolved' ? ' is-resolved' : ''}`} key={conflict.id}>
                  <div className="conflict-title"><strong>{conflict.entityTitle || '未命名记录'}</strong><span>{conflictFieldLabel(conflict.field)}</span></div>
                  {conflict.status === 'open' ? (
                    <>
                      <div className="conflict-choices">
                        <button type="button" disabled={busy} onClick={() => void chooseConflict(conflict, 'current')}>
                          <span>Mac 当前内容</span><pre>{formatConflictValue(conflict.current)}</pre><b>保留这一版</b>
                        </button>
                        <button type="button" disabled={busy} onClick={() => void chooseConflict(conflict, 'incoming')}>
                          <span>另一设备内容</span><pre>{formatConflictValue(conflict.incoming)}</pre><b>采用这一版</b>
                        </button>
                      </div>
                      <small>系统不会静默覆盖任一版本。</small>
                    </>
                  ) : (
                    <div className="conflict-resolved"><CheckCircle2 size={17} /><span>已处理，当前采用：{formatConflictValue(conflict.resolutionValue)}</span>{conflict.canUndo && <button type="button" disabled={busy} onClick={() => void undoConflict(conflict)}><Undo2 size={15} />撤销</button>}</div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {visibleAuthorityJobs.length > 0 && (
        <section className="authority-section authority-ai" aria-labelledby="mac-ai-heading">
          <header><span><Server size={18} /><strong id="mac-ai-heading">Mac AI 处理中心</strong></span><small>{queueStatus ? `${queueStatus.queued + queueStatus.processing} 个进行中 · ${queueStatus.total} 个有记录` : '任务状态由 Mac 统一保存'}</small></header>
          <div className="authority-ai-list">
            {visibleAuthorityJobs.map((job) => {
              const meta = authorityStatus(job.status);
              const busy = busyId === `mac:${job.id}`;
              return (
                <article className="authority-ai-card" key={job.id}>
                  <span className={`activity-kind is-${meta.tone}`}><Sparkles size={19} /></span>
                  <div><div><strong>{authorityTaskLabel(job)}</strong><span className={`activity-state is-${meta.tone}`}>{meta.label}</span></div><p>{job.message || 'Mac 已记录任务状态'}</p>{job.error && <small>{job.error}</small>}<footer><span>模型请求 {job.billableAttemptCount || 0} 次</span><time>{new Date(job.updatedAt).toLocaleString('zh-CN', { hour12: false })}</time></footer></div>
                  {job.requiresExplicitRetry && <button type="button" disabled={busy} onClick={() => void retryMacTask(job)}><RotateCcw size={15} />确认重试</button>}
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section className="activity-list" aria-live="polite">
        {loading && <div className="activity-skeleton"><span /><span /><span /></div>}
        {!loading && tasks.length === 0 && visibleAuthorityJobs.length === 0 && visibleConflicts.length === 0 && (
          <div className="activity-empty"><CheckCircle2 size={30} /><h2>当前没有任务</h2><p>拍题或给速记添加资料后，进度会出现在这里。</p></div>
        )}
        {tasks.map((task) => {
          const meta = statusMeta[task.status];
          const busy = busyId === task.id;
          const retryable = task.canRetry || (
            task.kind === 'ai_rename'
            && (task.status === 'failed_retryable' || task.status === 'failed_terminal')
          );
          const continuing = task.kind === 'capture_upload'
            && ['local_saved', 'queued', 'uploading'].includes(task.status);
          return (
            <article className="activity-card" key={task.id}>
              <span className={`activity-kind is-${meta.tone}`}>{taskIcon(task)}</span>
              <div className="activity-copy">
                <div><strong>{task.title || kindLabel(task)}</strong><span className={`activity-state is-${meta.tone}`}>{meta.label}</span></div>
                <p>{task.message || '任务状态已记录'}</p>
                {task.error && <small>{task.error}</small>}
                <footer>
                  <span>{kindLabel(task)}</span>
                  {task.provider && <span>{task.provider}{task.model ? ` · ${task.model}` : ''}</span>}
                  {task.fallbackProvider && <span>回退：{task.fallbackProvider}{task.fallbackModel ? ` · ${task.fallbackModel}` : ''}</span>}
                  {task.durationMs !== null && <span>{task.durationMs >= 1000 ? `${(task.durationMs / 1000).toFixed(1)} 秒` : `${Math.round(task.durationMs)} 毫秒`}</span>}
                  <time>{new Date(task.updatedAt).toLocaleString('zh-CN', { hour12: false })}</time>
                </footer>
                {task.progress > 0 && task.progress < 100 && <div className="activity-progress"><i style={{ width: `${task.progress}%` }} /></div>}
              </div>
              <div className="activity-actions">
                {retryable && <button type="button" disabled={busy} onClick={() => void retry(task)}><RotateCcw size={15} />{continuing ? '继续' : '重试'}</button>}
                {task.canCancel && <button type="button" disabled={busy} onClick={() => void cancel(task)}><StopCircle size={15} />取消</button>}
                {task.targetUrl && <button type="button" disabled={busy} onClick={() => void openTask(task)}>打开<ChevronRight size={15} /></button>}
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
