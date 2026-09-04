import { useEffect, useRef, useState } from 'react';
import { FileCode2, LoaderCircle, Paperclip, Settings2, ShieldCheck, Sparkles, X } from 'lucide-react';
import { generateQuickHtmlNote, IS_CLOUD_RUNTIME } from '../utils/notes';
import { navigateApp } from '../utils/appNavigation';
import {
  buildSafeHtmlArtifact,
  hashSafeHtmlArtifact,
  safeHtmlArtifactFileName,
} from '../utils/safeHtmlArtifact';
import '../quick-html-studio.css';

export type QuickHtmlAttachOutcome = {
  status: 'saved' | 'replayed' | 'rejected' | 'retryable';
  message: string;
};

export interface QuickHtmlStudioProps {
  noteUid: string;
  contextTitle: string;
  contextRemark: string;
  disabled?: boolean;
  onClose: () => void;
  onAttach: (file: File, operationId: string) => Promise<QuickHtmlAttachOutcome>;
}

interface PreparedHtmlArtifact {
  title: string;
  width: number;
  height: number;
  fileName: string;
  source: string;
  provider: string;
  model: string;
  artifactHash: string;
  contextSignature: string;
  operationId: string;
  createdAt: number;
  attemptCount: number;
  usedFallback: boolean;
}

const PROMPT_PRESETS = [
  { label: '参数可视化', prompt: '把这条速记做成可拖动参数的可视化演示，保留关键公式，并提供重置按钮。' },
  { label: '步骤演示', prompt: '把这条速记整理成逐步展开的推导演示，每一步都能单独查看提示与结论。' },
  { label: '自测练习', prompt: '根据这条速记生成一组即时自测题，提交后给出分步解析和错误提示。' },
] as const;

const contextSignatureOf = (noteUid: string, title: string, remark: string): string => [
  noteUid.trim(),
  title.trim(),
  remark.trim(),
].join('\u0000');

const createOperationId = (): string => {
  const randomId = globalThis.crypto?.randomUUID?.();
  return `quick-html-${randomId || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`}`;
};

export function QuickHtmlStudio({
  noteUid,
  contextTitle,
  contextRemark,
  disabled = false,
  onClose,
  onAttach,
}: QuickHtmlStudioProps) {
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [status, setStatus] = useState('');
  const [prepared, setPrepared] = useState<PreparedHtmlArtifact | null>(null);
  const generationBusyRef = useRef(false);
  const attachBusyRef = useRef(false);
  const mountedRef = useRef(true);
  const currentContextSignature = contextSignatureOf(noteUid, contextTitle, contextRemark);
  const latestContextRef = useRef(currentContextSignature);
  const contextChanged = Boolean(prepared && prepared.contextSignature !== currentContextSignature);

  useEffect(() => {
    latestContextRef.current = currentContextSignature;
  }, [currentContextSignature]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const generatePreview = async () => {
    if (disabled || generationBusyRef.current || prompt.trim().length < 3) return;
    const requestContextSignature = currentContextSignature;
    generationBusyRef.current = true;
    setGenerating(true);
    setStatus('AI 正在生成离线 HTML，并进行安全检查…');
    try {
      const artifact = await generateQuickHtmlNote({
        prompt,
        draftTitle: contextTitle,
        draftRemark: contextRemark,
      });
      const source = buildSafeHtmlArtifact({
        title: artifact.title,
        width: artifact.width,
        height: artifact.height,
        html: artifact.html,
        css: artifact.css,
        js: artifact.js,
      });
      const finalArtifactHash = await hashSafeHtmlArtifact(source);
      const routeCount = new Set(artifact.attempts.map((attempt) => `${attempt.provider || ''}/${attempt.model || ''}`)).size;
      const nextPrepared: PreparedHtmlArtifact = {
        title: artifact.title,
        width: artifact.width,
        height: artifact.height,
        fileName: safeHtmlArtifactFileName(artifact.title),
        source,
        provider: artifact.provider,
        model: artifact.model,
        artifactHash: finalArtifactHash || artifact.artifactHash,
        contextSignature: requestContextSignature,
        operationId: createOperationId(),
        createdAt: Date.now(),
        attemptCount: artifact.attempts.length,
        usedFallback: routeCount > 1,
      };
      if (!mountedRef.current) return;
      setPrepared(nextPrepared);
      const durationText = artifact.durationMs > 0 ? ` · ${(artifact.durationMs / 1000).toFixed(1)} 秒` : '';
      const attemptText = artifact.attempts.length > 1
        ? ` · ${artifact.attempts.length} 次尝试${routeCount > 1 ? '，已回退模型' : ''}`
        : '';
      setStatus(latestContextRef.current === requestContextSignature
        ? `已由 ${artifact.model || artifact.provider || 'AI'} 生成${durationText}${attemptText}；预览确认后再加入本条笔记。`
        : '生成期间已切换笔记。HTML 预览仍保留，但不能加入当前笔记；请重新生成。');
    } catch (cause) {
      if (!mountedRef.current) return;
      setStatus(cause instanceof Error
        ? `生成失败：${cause.message}；已有 HTML 预览仍保留。`
        : '生成失败，请稍后重试；已有 HTML 预览仍保留。');
    } finally {
      generationBusyRef.current = false;
      if (mountedRef.current) setGenerating(false);
    }
  };

  const attachPreview = async () => {
    if (!prepared || disabled || attachBusyRef.current) return;
    if (prepared.contextSignature !== currentContextSignature) {
      setStatus('当前笔记已变化，旧 HTML 预览不会被误附加；请基于当前笔记重新生成。');
      return;
    }
    const attachingArtifact = prepared;
    attachBusyRef.current = true;
    setAttaching(true);
    setStatus('正在把 HTML 加入本条笔记…');
    try {
      const file = new File([attachingArtifact.source], attachingArtifact.fileName, {
        type: 'text/html',
        lastModified: attachingArtifact.createdAt,
      });
      const outcome = await onAttach(file, attachingArtifact.operationId);
      if (!mountedRef.current) return;
      if (outcome.status === 'saved' || outcome.status === 'replayed') {
        setPrepared((current) => current?.operationId === attachingArtifact.operationId ? null : current);
        setPrompt('');
        setStatus(outcome.message || (outcome.status === 'replayed' ? '这份 HTML 已经加入过，无需重复保存。' : 'HTML 已加入本条笔记。'));
      } else {
        setStatus(`${outcome.message || 'HTML 暂未加入。'} HTML 预览仍保留，可直接重试。`);
      }
    } catch (cause) {
      if (!mountedRef.current) return;
      setStatus(cause instanceof Error
        ? `加入失败：${cause.message}。HTML 预览与操作编号仍保留，可直接重试。`
        : '加入失败。HTML 预览与操作编号仍保留，可直接重试。');
    } finally {
      attachBusyRef.current = false;
      if (mountedRef.current) setAttaching(false);
    }
  };

  return (
    <section
      id={`quick-html-studio-${noteUid}`}
      className={`quick-html-studio${prepared ? ' has-preview' : ''}`}
      aria-label="AI 创建 HTML 交互笔记"
      aria-busy={generating || attaching}
    >
      <header>
        <div className="quick-html-studio-heading">
          <span className="quick-html-studio-mark"><Sparkles size={18} /></span>
          <span>
            <small>AI 交互创作</small>
            <strong>把当前速记变成可操作的 HTML</strong>
            <em>生成、检查、预览都在这里完成，确认后才会加入资料。</em>
          </span>
        </div>
        <div className="quick-html-studio-header-actions">
          <span><ShieldCheck size={13} />安全预览</span>
          {!IS_CLOUD_RUNTIME && <button
            type="button"
            onClick={() => navigateApp('?aiConfig=1&task=interactive_note_generation')}
            aria-label="配置速记 HTML 使用的模型和生成参数"
            title="配置模型、超时、重试、风格和交互参数"
          ><Settings2 size={16} /></button>}
          <button type="button" onClick={onClose} aria-label="关闭 AI 交互创作"><X size={17} /></button>
        </div>
      </header>
      <div className="quick-html-studio-grid">
        <div className="quick-html-studio-compose">
          <div className="quick-html-studio-context">
            <FileCode2 size={16} />
            <span><small>创作依据</small><strong>{contextTitle.trim() || '当前未命名速记'}</strong></span>
          </div>
          <label>
            <span>你希望它怎样交互？</span>
            <textarea
              value={prompt}
              maxLength={650}
              disabled={disabled || generating || attaching}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="例如：做成可拖动参数的函数演示，保留关键公式，并提供步骤提示与重置按钮"
            />
          </label>
          <div className="quick-html-studio-presets" aria-label="快速创作模板">
            <span>快速开始</span>
            {PROMPT_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.label}
                disabled={disabled || generating || attaching}
                onClick={() => setPrompt(preset.prompt)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="quick-html-studio-actions">
            <button type="button" onClick={() => void generatePreview()} disabled={disabled || generating || attaching || prompt.trim().length < 3}>
              {generating ? <LoaderCircle className="is-spinning" size={15} /> : <Sparkles size={15} />}
              {generating ? '生成并检查中…' : prepared ? '重新生成预览' : '生成安全预览'}
            </button>
            {prepared && <button
              type="button"
              className="primary"
              onClick={() => void attachPreview()}
              disabled={disabled || generating || attaching || contextChanged}
            >
              {attaching ? <LoaderCircle className="is-spinning" size={15} /> : <Paperclip size={15} />}
              {attaching ? '正在加入…' : '加入本条速记'}
            </button>}
          </div>
          {contextChanged && <p className="quick-html-studio-warning" role="alert">当前速记内容已变化。旧预览只供查看，不能附加到新上下文。</p>}
          {status && <p className="quick-html-studio-status" role="status" aria-live="polite">{status}</p>}
        </div>
        {prepared && <div className="quick-html-studio-preview">
          <div>
            <span><strong>{prepared.title}</strong><small>{prepared.fileName} · {prepared.width}×{prepared.height} · {prepared.artifactHash.slice(0, 12) || '待校验'}</small></span>
            <small>{prepared.model || prepared.provider || 'AI'} · {prepared.attemptCount || 1} 次尝试{prepared.usedFallback ? ' · 已回退' : ''} · 操作 {prepared.operationId.slice(-8)}</small>
          </div>
          <iframe sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={prepared.source} title={`${prepared.title} HTML 预览`} />
        </div>}
      </div>
    </section>
  );
}
