import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleGauge,
  Download,
  FolderOpen,
  LoaderCircle,
  Plus,
  RefreshCcw,
  RotateCcw,
  Save,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UploadCloud,
  WandSparkles,
} from 'lucide-react';
import {
  fetchAiConfiguration,
  fetchReviewSyncStatus,
  pullReviewPdfs,
  pushReviewData,
  saveAiConfiguration,
  selectReviewOutputDirectory,
  type AiConfigurationSnapshot,
  type ReviewSyncStatus,
  type AiNamingRule,
  type AiTaskParameterDefinition,
  type AiTaskDefinition,
  type AiTaskSettings,
} from '../utils/aiConfig';

const providerNames: Record<string, string> = {
  qwen: '通义千问',
  gemini: 'Gemini',
  kimi: 'Kimi',
};

const capabilityNames: Record<string, string> = {
  text: '文本',
  vision: '图片',
  json: '结构化输出',
  longContext: '长上下文',
  reasoning: '推理',
};

const instructionExamples: Record<string, string> = {
  note_naming: '例如：标题优先使用图片里出现的教材章节名；老师姓名不进入标题。',
  note_enrichment: '例如：错因必须写成可执行的改进动作；不要把单纯计算量大的题判断为好题。',
  note_image_understanding: '无备注时优先使用高质量视觉模型；只依据图片可见内容，不猜测缺失信息。',
  widget_generation: '例如：按钮使用紧凑布局；所有计时状态必须在组件内可重置。',
  canvas_organization: '例如：同一道题的原题、草稿、订正按从左到右排列；不同题目上下分组。',
  weekly_review_pdf: '只能分组和排序；禁止补充答案、知识讲解、例题、口诀或额外总结。',
  note_classification: '例如：涉及多个知识点时，主分类选择题目最终考查的知识点。',
  taxonomy: '例如：同义缩写归并为正式教材名称，不合并上下位知识点。',
  flashcard_generation: '例如：正面必须是能独立作答的问题，背面优先写判定步骤而不是整段抄录。',
  custom: '输入这个任务需要长期遵守的专用规则。',
};

const cloneTasks = (tasks: Record<string, AiTaskSettings>) => JSON.parse(JSON.stringify(tasks)) as Record<string, AiTaskSettings>;

const isConfigured = (settings: AiTaskSettings | undefined) => Boolean(settings && Object.keys(settings).length > 0);

const newRuleId = (): string => typeof crypto.randomUUID === 'function'
  ? `naming-${crypto.randomUUID()}`
  : `naming-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const tankNumberRule = (): AiNamingRule => ({
  id: newRuleId(),
  name: '缸号命名',
  enabled: true,
  when: '图片中出现明确标注的“缸号”字段',
  extract: '读取“缸号”标签右侧或同一单元格对应的完整字段值，保留数字、字母和连字符；不要误用生产单号、纱批、颜色编号或日期',
  titleTemplate: '{value}',
  validationHint: '典型格式如 250626-088；必须来自图片中“缸号”字段附近的可见文字，无法看清时不要匹配',
});

const blankNamingRule = (): AiNamingRule => ({
  id: newRuleId(),
  name: '新命名规则',
  enabled: true,
  when: '',
  extract: '',
  titleTemplate: '{value}',
  validationHint: '',
});

export function AiConfigPage() {
  const [snapshot, setSnapshot] = useState<AiConfigurationSnapshot | null>(null);
  const [draft, setDraft] = useState<Record<string, AiTaskSettings>>({});
  const [selectedTaskId, setSelectedTaskId] = useState('note_naming');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [reviewStatus, setReviewStatus] = useState<ReviewSyncStatus | null>(null);
  const [reviewAction, setReviewAction] = useState<'push' | 'pull' | 'directory' | 'refresh' | ''>('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchAiConfiguration()
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        setDraft(cloneTasks(next.tasks));
        const firstActive = next.taskDefinitions.find((task) => task.active);
        if (firstActive) setSelectedTaskId(firstActive.id);
        setError('');
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedTaskId !== 'weekly_review_pdf') return undefined;
    let cancelled = false;
    let timer = 0;
    const refresh = async () => {
      try {
        const next = await fetchReviewSyncStatus();
        if (!cancelled) setReviewStatus(next);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void refresh();
    timer = window.setInterval(() => void refresh(), 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedTaskId]);

  const selectedTask = snapshot?.taskDefinitions.find((task) => task.id === selectedTaskId) || null;
  const settings = draft[selectedTaskId] || {};
  const selectedParameterGroups = useMemo(() => {
    const groups = new Map<string, AiTaskParameterDefinition[]>();
    (selectedTask?.parameters || []).forEach((parameter) => {
      groups.set(parameter.group, [...(groups.get(parameter.group) || []), parameter]);
    });
    return [...groups.entries()];
  }, [selectedTask]);
  const dirty = useMemo(() => snapshot
    ? JSON.stringify(draft) !== JSON.stringify(snapshot.tasks)
    : false, [draft, snapshot]);

  const compatibleModels = useMemo(() => {
    if (!snapshot || !selectedTask) return [];
    return snapshot.providers.flatMap((provider) => provider.models
      .filter((model) => selectedTask.defaults.capabilities.every((capability) => model.capabilities.includes(capability)))
      .map((model) => ({
        providerId: provider.id,
        providerName: providerNames[provider.id] || provider.id,
        model,
        circuitOpen: provider.circuit.open,
      })));
  }, [selectedTask, snapshot]);

  const compatibleProviders = useMemo(() => {
    const providers = new Map<string, { providerId: string; providerName: string; circuitOpen: boolean }>();
    compatibleModels.forEach(({ providerId, providerName, circuitOpen }) => {
      if (!providers.has(providerId)) providers.set(providerId, { providerId, providerName, circuitOpen });
    });
    return [...providers.values()];
  }, [compatibleModels]);

  const selectedProviderModels = useMemo(() => compatibleModels.filter(({ providerId }) => (
    !settings.providerId || providerId === settings.providerId
  )), [compatibleModels, settings.providerId]);

  const updateTask = (patch: Partial<AiTaskSettings>, remove: Array<keyof AiTaskSettings> = []) => {
    setDraft((current) => {
      const nextTask = { ...(current[selectedTaskId] || {}), ...patch };
      remove.forEach((key) => delete nextTask[key]);
      return { ...current, [selectedTaskId]: nextTask };
    });
    setSavedMessage('');
  };

  const parameterValue = (parameter: AiTaskParameterDefinition): string | number | boolean => (
    Object.prototype.hasOwnProperty.call(settings.options || {}, parameter.id)
      ? settings.options?.[parameter.id] as string | number | boolean
      : parameter.default
  );

  const updateTaskParameter = (parameter: AiTaskParameterDefinition, value: string | number | boolean) => {
    updateTask({ options: { ...(settings.options || {}), [parameter.id]: value } });
  };

  const resetTask = () => {
    setDraft((current) => {
      const next = { ...current };
      delete next[selectedTaskId];
      return next;
    });
    setSavedMessage('');
  };

  const handleProviderChange = (providerId: string) => {
    if (!providerId) updateTask({}, ['providerId', 'modelId']);
    else updateTask({ providerId }, ['modelId']);
  };

  const chooseReviewDirectory = async (parameter: AiTaskParameterDefinition) => {
    setReviewAction('directory');
    setError('');
    try {
      const result = await selectReviewOutputDirectory(String(parameterValue(parameter) || ''));
      if (result.path) updateTaskParameter(parameter, result.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setReviewAction('');
    }
  };

  const runReviewAction = async (action: 'push' | 'pull' | 'refresh') => {
    setReviewAction(action);
    setError('');
    setSavedMessage('');
    try {
      if (action === 'push') {
        const result = await pushReviewData();
        setSavedMessage(result.skipped
          ? result.reason || '本次同步已跳过。'
          : result.accepted === false
            ? '已有综合复习任务在后台运行。'
            : '同步已转入后台；你可以离开此页面，状态会自动刷新。');
      } else if (action === 'pull') {
        const result = await pullReviewPdfs();
        setSavedMessage(result.skipped
          ? result.reason || '本次下载已跳过。'
          : result.accepted === false
            ? '已有综合复习任务在后台运行。'
            : 'PDF 检查已转入后台；下载完成后状态会自动更新。');
      }
      setReviewStatus(await fetchReviewSyncStatus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setReviewAction('');
    }
  };

  const setNamingRules = (namingRules: AiNamingRule[]) => {
    if (namingRules.length > 0) updateTask({ namingRules });
    else updateTask({}, ['namingRules']);
  };

  const updateNamingRule = (id: string, patch: Partial<AiNamingRule>) => {
    setNamingRules((settings.namingRules || []).map((rule) => rule.id === id ? { ...rule, ...patch } : rule));
  };

  const removeNamingRule = (id: string) => {
    setNamingRules((settings.namingRules || []).filter((rule) => rule.id !== id));
  };

  const handleSave = async () => {
    const invalidRule = draft.note_naming?.namingRules?.find((rule) => (
      !rule.name.trim() || !rule.when.trim() || !rule.extract.trim() || !rule.titleTemplate.trim()
    ));
    if (invalidRule) {
      setError(`命名规则“${invalidRule.name || '未命名规则'}”还没有填写完整。`);
      return;
    }
    setSaving(true);
    setError('');
    setSavedMessage('');
    try {
      const next = await saveAiConfiguration(draft);
      setSnapshot(next);
      setDraft(cloneTasks(next.tasks));
      setSavedMessage('已保存，后续 AI 任务会立即使用新配置。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <main className="ai-config-page ai-config-loading">
        <LoaderCircle aria-hidden="true" className="is-spinning" size={28} />
        <strong>正在读取 AI 任务配置…</strong>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="ai-config-page ai-config-unavailable">
        <AlertTriangle aria-hidden="true" size={34} />
        <h1>无法打开 AI 配置</h1>
        <p>{error || '本地 AI 配置服务没有响应。'}</p>
        <p>出于安全考虑，这个页面只能在运行服务的 Windows 主机上使用。</p>
        <button type="button" onClick={() => window.location.reload()}>重新连接</button>
      </main>
    );
  }

  const activeTasks = snapshot.taskDefinitions.filter((task) => task.active);
  const reservedTasks = snapshot.taskDefinitions.filter((task) => !task.active);

  const renderTask = (task: AiTaskDefinition) => {
    const taskSettings = draft[task.id] || {};
    const selectedModel = taskSettings.modelId
      ? `${providerNames[taskSettings.providerId || ''] || taskSettings.providerId || ''} · ${taskSettings.modelId}`
      : '自动选择模型';
    return (
      <button
        className={selectedTaskId === task.id ? 'is-active' : ''}
        key={task.id}
        type="button"
        onClick={() => setSelectedTaskId(task.id)}
      >
        <span className="ai-task-icon"><BrainCircuit aria-hidden="true" size={18} /></span>
        <span className="ai-task-copy">
          <strong>{task.label}</strong>
          <small>{selectedModel}</small>
        </span>
        {isConfigured(taskSettings) && <span className="ai-task-dot" title="已自定义" />}
        <ChevronRight aria-hidden="true" size={17} />
      </button>
    );
  };

  return (
    <main className="ai-config-page">
      <header className="ai-config-header">
        <div>
          <span className="ai-config-eyebrow"><SlidersHorizontal size={15} /> 本地主机配置</span>
          <h1>AI 任务配置</h1>
          <p>给不同任务单独选择模型和规则，原有业务校验与安全限制保持不变。</p>
        </div>
        <div className="ai-config-actions">
          <span className={dirty ? 'ai-config-change is-dirty' : 'ai-config-change'}>
            {dirty ? '有未保存修改' : '配置已同步'}
          </span>
          <button className="ai-config-save" disabled={!dirty || saving} type="button" onClick={() => void handleSave()}>
            {saving ? <LoaderCircle className="is-spinning" size={17} /> : <Save size={17} />}
            {saving ? '保存中' : '保存全部'}
          </button>
        </div>
      </header>

      {(error || savedMessage || snapshot.error) && (
        <div className={`ai-config-notice ${error || snapshot.error ? 'is-error' : 'is-success'}`} role="status">
          {error || snapshot.error ? <AlertTriangle size={18} /> : <Check size={18} />}
          <span>{error || snapshot.error || savedMessage}</span>
        </div>
      )}

      <section className="ai-provider-strip" aria-label="AI 供应商状态">
        {snapshot.providers.length > 0 ? snapshot.providers.map((provider) => (
          <article className={provider.circuit.open ? 'is-warning' : ''} key={provider.id}>
            <span className="ai-provider-icon"><ServerCog size={18} /></span>
            <span>
              <strong>{providerNames[provider.id] || provider.id}</strong>
              <small>{provider.models.map((model) => model.id).join('、')}</small>
            </span>
            <em>{provider.circuit.open ? '暂不可用' : '已配置'}</em>
          </article>
        )) : (
          <article className="is-warning ai-provider-empty">
            <AlertTriangle size={18} />
            <span><strong>没有可用模型</strong><small>请先检查 ai-providers.json 中的供应商与 Key。</small></span>
          </article>
        )}
      </section>

      <div className="ai-config-workspace">
        <aside className="ai-task-list">
          <div className="ai-task-list-heading">
            <strong>正在使用的任务</strong>
            <span>{activeTasks.length}</span>
          </div>
          {activeTasks.map(renderTask)}
          {reservedTasks.length > 0 && (
            <>
              <div className="ai-task-list-heading is-secondary">
                <strong>预留任务</strong>
                <span>{reservedTasks.length}</span>
              </div>
              {reservedTasks.map(renderTask)}
            </>
          )}
        </aside>

        {selectedTask && (
          <section className="ai-task-editor">
            <header>
              <div>
                <span>{selectedTask.active ? '当前流程已接入' : '预留任务配置'}</span>
                <h2>{selectedTask.label}</h2>
                <p>{selectedTask.description}</p>
              </div>
              <button className="ai-reset-task" disabled={!isConfigured(draft[selectedTaskId])} type="button" onClick={resetTask}>
                <RotateCcw size={15} /> 恢复系统默认
              </button>
            </header>

            <section className="ai-task-specific-settings">
              <div className="ai-config-section-heading">
                <span><Sparkles size={16} /> {selectedTask.label}专属规则</span>
                <small>这里的参数只属于当前任务，并会同时进入 AI 提示与程序后处理。</small>
              </div>
              {selectedParameterGroups.length > 0 ? selectedParameterGroups.map(([group, parameters]) => (
                <div className="ai-parameter-group" key={group}>
                  <strong>{group}</strong>
                  <div className="ai-parameter-grid">
                    {parameters.map((parameter) => {
                      const value = parameterValue(parameter);
                      if (parameter.type === 'boolean') {
                        return (
                          <label className="ai-parameter-switch" key={parameter.id}>
                            <span><b>{parameter.label}</b><small>{parameter.description}</small></span>
                            <input
                              checked={value === true}
                              type="checkbox"
                              onChange={(event) => updateTaskParameter(parameter, event.target.checked)}
                            />
                          </label>
                        );
                      }
                       if (parameter.type === 'path') {
                         return (
                           <div className="ai-config-field ai-path-parameter" key={parameter.id}>
                             <span>{parameter.label}</span>
                             <small>{parameter.description}</small>
                             <div>
                               <input maxLength={parameter.maxLength} type="text" value={String(value)} onChange={(event) => updateTaskParameter(parameter, event.target.value)} />
                               <button disabled={reviewAction === 'directory'} type="button" onClick={() => void chooseReviewDirectory(parameter)}>
                                 {reviewAction === 'directory' ? <LoaderCircle className="is-spinning" size={15} /> : <FolderOpen size={15} />} 选择目录
                               </button>
                             </div>
                           </div>
                         );
                       }
                       return (
                         <label className="ai-config-field" key={parameter.id}>
                           <span>{parameter.label}</span>
                           <small>{parameter.description}</small>
                           {parameter.type === 'select' ? (
                             <select value={String(value)} onChange={(event) => updateTaskParameter(parameter, event.target.value)}>
                               {(parameter.options || []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                             </select>
                           ) : parameter.type === 'text' ? (
                             <input maxLength={parameter.maxLength} type="text" value={String(value)} onChange={(event) => updateTaskParameter(parameter, event.target.value)} />
                           ) : (
                             <span className="ai-number-with-unit">
                               <input
                                 inputMode="decimal"
                                 max={parameter.max}
                                 min={parameter.min}
                                 step={parameter.step}
                                 type="number"
                                 value={Number(value)}
                                 onChange={(event) => updateTaskParameter(parameter, Number(event.target.value))}
                               />
                               {parameter.unit && <em>{parameter.unit}</em>}
                             </span>
                           )}
                         </label>
                       );
                    })}
                  </div>
                </div>
              )) : (
                <p className="ai-no-special-parameters">这个预留任务暂时只有自由规则；接入具体业务后会显示可强制校验的专属参数。</p>
              )}
            </section>

            {selectedTaskId === 'weekly_review_pdf' && (
              <section className="ai-review-sync-panel">
                <header>
                  <div>
                    <span><UploadCloud size={16} /> GitHub 综合复习流水线</span>
                    <small>仓库是公开的。只上传已确认的错题和背诵；AI 只能分组，不生成额外正文。</small>
                  </div>
                  <button disabled={reviewAction !== ''} type="button" onClick={() => void runReviewAction('refresh')}>
                    {reviewAction === 'refresh' ? <LoaderCircle className="is-spinning" size={15} /> : <RefreshCcw size={15} />} 刷新状态
                  </button>
                </header>
                <div className="ai-review-public-warning">
                  <AlertTriangle size={17} />
                  <span>题目截图、手写过程和备注会进入公开仓库。请不要同步含姓名、账号、电话或不希望公开的信息。</span>
                </div>
                <div className="ai-review-status-grid">
                  <div><small>仓库</small><strong>{reviewStatus?.settings?.repository || String(settings.options?.repository || 'strawberryCao/Caobijidata')}</strong></div>
                  <div><small>本地目录</small><strong>{reviewStatus?.settings?.outputDirectory || String(settings.options?.localOutputDir || '桌面\考研复习资料')}</strong></div>
                  <div><small>最近上传</small><strong>{reviewStatus?.lastPushAt ? new Date(reviewStatus.lastPushAt).toLocaleString() : '尚未上传'}</strong></div>
                  <div><small>最近 PDF</small><strong>{reviewStatus?.lastRemoteGeneratedAt ? new Date(reviewStatus.lastRemoteGeneratedAt).toLocaleString() : '尚未下载'}</strong></div>
                </div>
                {reviewStatus?.running && (
                  <div className="ai-review-progress">
                    <div><span>{reviewStatus.message || '后台任务正在运行…'}</span><strong>{Math.round(reviewStatus.progress || 0)}%</strong></div>
                    <progress max="100" value={reviewStatus.progress || 0} />
                  </div>
                )}
                {reviewStatus?.lastError && <p className="ai-review-last-error">{reviewStatus.lastError}</p>}
                <div className="ai-review-actions">
                  <button disabled={dirty || saving || reviewAction !== '' || reviewStatus?.running === true} type="button" onClick={() => void runReviewAction('push')}>
                    {reviewAction === 'push' || reviewStatus?.runningAction === 'push' ? <LoaderCircle className="is-spinning" size={16} /> : <UploadCloud size={16} />} 立即同步已确认内容
                  </button>
                  <button disabled={dirty || saving || reviewAction !== '' || reviewStatus?.running === true} type="button" onClick={() => void runReviewAction('pull')}>
                    {reviewAction === 'pull' || reviewStatus?.runningAction === 'pull' ? <LoaderCircle className="is-spinning" size={16} /> : <Download size={16} />} 下载最新两份 PDF
                  </button>
                  {dirty && <small>先保存当前 AI 配置，再执行同步或下载。</small>}
                </div>
              </section>
            )}

            {selectedTaskId === 'note_naming' && (
              <section className="ai-naming-rules">
                <header>
                  <div>
                    <span><WandSparkles size={16} />字段命名规则</span>
                    <small>模型先判断规则是否匹配，再提取字段；程序使用模板生成标题。规则不匹配时仍使用普通 AI 标题。</small>
                  </div>
                  <div>
                    <button type="button" onClick={() => setNamingRules([...(settings.namingRules || []), tankNumberRule()])}>添加缸号规则</button>
                    <button type="button" onClick={() => setNamingRules([...(settings.namingRules || []), blankNamingRule()])}><Plus size={14} />自定义规则</button>
                  </div>
                </header>

                {(settings.namingRules || []).length > 0 ? (
                  <div className="ai-naming-rule-list">
                    {(settings.namingRules || []).map((rule, index) => (
                      <article key={rule.id}>
                        <header>
                          <label>
                            <input checked={rule.enabled !== false} type="checkbox" onChange={(event) => updateNamingRule(rule.id, { enabled: event.target.checked })} />
                            <span>规则 {index + 1}</span>
                          </label>
                          <button aria-label={`删除${rule.name || '命名规则'}`} type="button" onClick={() => removeNamingRule(rule.id)}><Trash2 size={14} />删除</button>
                        </header>
                        <div className="ai-naming-rule-grid">
                          <label><span>规则名称</span><input value={rule.name} onChange={(event) => updateNamingRule(rule.id, { name: event.target.value })} placeholder="例如：缸号命名" /></label>
                          <label><span>标题模板</span><input value={rule.titleTemplate} onChange={(event) => updateNamingRule(rule.id, { titleTemplate: event.target.value })} placeholder="{value}" /></label>
                          <label className="is-wide"><span>何时使用</span><textarea value={rule.when} onChange={(event) => updateNamingRule(rule.id, { when: event.target.value })} placeholder="例如：图片中存在明确标注的订单号字段" /></label>
                          <label className="is-wide"><span>提取内容</span><textarea value={rule.extract} onChange={(event) => updateNamingRule(rule.id, { extract: event.target.value })} placeholder="说明要读取哪个字段，以及不能和哪些字段混淆" /></label>
                          <label className="is-wide"><span>校验提示（可选）</span><input value={rule.validationHint || ''} onChange={(event) => updateNamingRule(rule.id, { validationHint: event.target.value })} placeholder="例如：典型格式为 ABC-2026-001，必须能在原图中直接看到" /></label>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="ai-naming-rule-empty">尚未设置字段规则。普通学习资料仍按原来的科目与内容标题命名。</p>
                )}
                <p className="ai-naming-template-help">模板支持 <code>{'{value}'}</code>（提取值）、<code>{'{subject}'}</code>（科目）、<code>{'{aiTitle}'}</code>（AI 普通标题）。最终仍会自动过滤 Windows 非法字符。</p>
              </section>
            )}

            <div className="ai-config-section-heading is-common">
              <span><SlidersHorizontal size={16} /> 模型与运行设置</span>
              <small>以下项目在各任务中独立保存，但作用都是控制模型调用方式。</small>
            </div>

            <div className="ai-config-grid">
              <label className="ai-config-field">
                <span>AI 厂家</span>
                <small>每个任务可以单独指定供应商</small>
                <select value={settings.providerId || ''} onChange={(event) => handleProviderChange(event.target.value)}>
                  <option value="">系统自动选择厂家</option>
                  {compatibleProviders.map(({ providerId, providerName, circuitOpen }) => (
                    <option disabled={circuitOpen} key={providerId} value={providerId}>
                      {providerName}{circuitOpen ? '（暂不可用）' : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label className="ai-config-field ai-config-model-field">
                <span>厂家模型</span>
                <small>{settings.providerId ? '只显示该厂家中满足任务能力要求的模型' : '先选厂家，或保持自动路由'}</small>
                <select
                  disabled={!settings.providerId}
                  value={settings.modelId || ''}
                  onChange={(event) => event.target.value
                    ? updateTask({ modelId: event.target.value })
                    : updateTask({}, ['modelId'])}
                >
                  <option value="">{settings.providerId ? '该厂家自动选择模型' : '请先选择厂家'}</option>
                  {selectedProviderModels.map(({ providerId, model, circuitOpen }) => (
                    <option disabled={circuitOpen} key={`${providerId}::${model.id}`} value={model.id}>
                      {model.id}{model.catalogOnly ? '（可选目录）' : '（当前配置）'}{circuitOpen ? '（暂不可用）' : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label className="ai-config-field">
                <span>任务难度</span>
                <small>影响自动路由时对质量与速度的权衡</small>
                <select
                  value={settings.difficulty || ''}
                  onChange={(event) => event.target.value
                    ? updateTask({ difficulty: event.target.value as AiTaskSettings['difficulty'] })
                    : updateTask({}, ['difficulty'])}
                >
                  <option value="">系统默认（{selectedTask.defaults.difficulty}）</option>
                  <option value="low">低：优先速度与成本</option>
                  <option value="medium">中：平衡模式</option>
                  <option value="high">高：优先质量</option>
                </select>
              </label>

              <label className="ai-config-field">
                <span>创造性 / 温度</span>
                <small>命名建议 0.1–0.3；数值越大变化越多</small>
                <input
                  inputMode="decimal"
                  max="2"
                  min="0"
                  placeholder="使用任务默认值"
                  step="0.05"
                  type="number"
                  value={settings.temperature ?? ''}
                  onChange={(event) => event.target.value === ''
                    ? updateTask({}, ['temperature'])
                    : updateTask({ temperature: Number(event.target.value) })}
                />
              </label>

              <label className="ai-config-field">
                <span>超时时间（秒）</span>
                <small>网络较慢时可适当调大，范围 1–300 秒</small>
                <input
                  inputMode="numeric"
                  max="300"
                  min="1"
                  placeholder={`${Math.round((selectedTask.defaults.timeoutMs || snapshot.routing.timeoutMs) / 1000)}（任务默认）`}
                  type="number"
                  value={settings.timeoutMs === undefined ? '' : Math.round(settings.timeoutMs / 1000)}
                  onChange={(event) => event.target.value === ''
                    ? updateTask({}, ['timeoutMs'])
                    : updateTask({ timeoutMs: Number(event.target.value) * 1000 })}
                />
              </label>
            </div>

            <div className="ai-config-switches">
              <label>
                <span>
                  <strong>启用此任务的 AI</strong>
                  <small>关闭后会使用该功能原有的本地降级结果（若该功能支持）</small>
                </span>
                <input
                  checked={settings.enabled !== false}
                  type="checkbox"
                  onChange={(event) => updateTask({ enabled: event.target.checked })}
                />
              </label>
              <label className={!settings.modelId ? 'is-disabled' : ''}>
                <span>
                  <strong>首选模型失败时自动切换</strong>
                  <small>关闭后只调用上面指定的模型，失败时不尝试其他模型</small>
                </span>
                <input
                  checked={settings.fallback !== false}
                  disabled={!settings.modelId}
                  type="checkbox"
                  onChange={(event) => updateTask({ fallback: event.target.checked })}
                />
              </label>
            </div>

            <label className="ai-instructions-field">
              <span>{selectedTask.label}自由规则</span>
              <small>
                {instructionExamples[selectedTaskId] || instructionExamples.custom}
                这部分会作为当前任务的长期附加指令。
              </small>
              <textarea
                maxLength={6000}
                placeholder={`输入${selectedTask.label}需要长期遵守的补充规则…`}
                value={settings.customInstructions || ''}
                onChange={(event) => event.target.value
                  ? updateTask({ customInstructions: event.target.value })
                  : updateTask({}, ['customInstructions'])}
              />
              <em>{(settings.customInstructions || '').length} / 6000</em>
            </label>

            <footer className="ai-task-safety">
              <ShieldCheck size={18} />
              <span>
                <strong>业务约束不会被覆盖</strong>
                <small>JSON 字段、文件安全规则、分类数据结构等仍由程序强制校验。</small>
              </span>
              <CircleGauge size={18} />
              <span>
                <strong>任务要求</strong>
                <small>{selectedTask.defaults.capabilities.map((item) => capabilityNames[item] || item).join(' · ')}</small>
              </span>
            </footer>
          </section>
        )}
      </div>
    </main>
  );
}
