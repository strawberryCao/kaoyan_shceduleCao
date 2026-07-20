import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Clipboard,
  FolderOpen,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { CanvasWorkspace, renderCanvasPreview, type CanvasWorkspaceHandle } from './CanvasWorkspace';
import {
  createEmptyCanvasDocument,
  getCanvasCompletionIssues,
  parseCanvasDocument,
  type CanvasDocument,
  type CanvasInkStroke,
} from '../utils/canvasDocument';
import {
  CanvasSyncConflictError,
  deleteCanvasProject,
  getCanvasClientId,
  listCanvasProjects,
  loadCanvasProject,
  saveCanvasProject,
  sendCanvasLiveStroke,
  subscribeCanvasProjectEvents,
  type CanvasProjectEvent,
  type CanvasProjectSummary,
} from '../utils/canvasProjects';
import { createNoteUid, saveNoteImage } from '../utils/notes';
type DraftStatus = 'saving' | 'saved' | 'failed';

const LAST_CANVAS_DRAFT_KEY = 'kaoyan.canvas.lastDraftId.v1';
const CANVAS_REMARK_KEY_PREFIX = 'kaoyan.canvas.publishRemark.v1.';
const SAFE_CANVAS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

interface InitialCanvasState {
  document: CanvasDocument;
  restoredDraft: boolean;
}

interface CanvasSyncConflict {
  actualRevision: number;
}

const createInitialCanvasState = (): InitialCanvasState => {
  const document = createEmptyCanvasDocument();
  const params = new URLSearchParams(window.location.search);
  const requestedDraftId = params.get('canvasDraft')
    || (!params.get('canvasProject') ? localStorage.getItem(LAST_CANVAS_DRAFT_KEY) : null);
  if (!requestedDraftId || !SAFE_CANVAS_ID.test(requestedDraftId)) {
    return { document, restoredDraft: false };
  }

  try {
    const saved = localStorage.getItem(`kaoyan.canvas.draft.v1.${requestedDraftId}`);
    if (saved) {
      const draft = parseCanvasDocument(saved);
      if (draft.id === requestedDraftId) return { document: draft, restoredDraft: true };
    }
  } catch {
    // A malformed local draft must not prevent the canvas page from opening.
  }

  document.id = requestedDraftId;
  return { document, restoredDraft: false };
};

const readCanvasRemark = (document: CanvasDocument): string => (
  localStorage.getItem(`${CANVAS_REMARK_KEY_PREFIX}${document.id}`)
  ?? document.publishRemark
  ?? ''
);

const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('无法读取画布预览图。'));
  reader.readAsDataURL(blob);
});

const hasCanvasContent = (document: CanvasDocument): boolean => (
  document.images.length > 0
  || document.texts.length > 0
  || document.annotations.length > 0
  || document.relations.length > 0
  || document.strokes.length > 0
);

const canvasSemanticFingerprint = (document: CanvasDocument, publishRemark: string): string => JSON.stringify({
  title: document.title,
  publishRemark,
  images: document.images.map(({ src, ...image }) => ({
    ...image,
    srcLength: src.length,
    srcTail: src.slice(-64),
  })),
  texts: document.texts,
  anchors: document.anchors,
  annotations: document.annotations,
  relations: document.relations ?? [],
  strokes: document.strokes ?? [],
});

const formatProjectTime = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
};

export function NoteCapturePage() {
  const initialCanvasStateRef = useRef<InitialCanvasState | null>(null);
  if (!initialCanvasStateRef.current) initialCanvasStateRef.current = createInitialCanvasState();
  const workspaceRef = useRef<CanvasWorkspaceHandle>(null);
  const initialProjectAttemptedRef = useRef(false);
  const lastPublishedFingerprintRef = useRef<string | null>(null);
  const publishOperationRef = useRef<{ fingerprint: string; noteUid: string } | null>(null);
  const changeSequenceRef = useRef(0);
  const publishingRef = useRef(false);
  const persistInFlightRef = useRef(false);
  const projectsRefreshInFlightRef = useRef(false);
  const activeCanvasIdRef = useRef(initialCanvasStateRef.current.document.id);
  const openRequestSequenceRef = useRef(0);
  const canvasClientIdRef = useRef(getCanvasClientId());
  const syncedRevisionRef = useRef(initialCanvasStateRef.current.document.syncRevision);
  const canvasDirtyRef = useRef(initialCanvasStateRef.current.restoredDraft);

  const [canvasDocument, setCanvasDocument] = useState<CanvasDocument>(() => initialCanvasStateRef.current!.document);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [canvasRemark, setCanvasRemark] = useState(() => readCanvasRemark(initialCanvasStateRef.current!.document));
  const [canvasMessage, setCanvasMessage] = useState('');
  const [canvasDirty, setCanvasDirty] = useState(() => initialCanvasStateRef.current!.restoredDraft);
  const [canvasSaving, setCanvasSaving] = useState(false);
  const [canvasDeleting, setCanvasDeleting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>('saved');
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [syncConflict, setSyncConflict] = useState<CanvasSyncConflict | null>(null);

  useEffect(() => {
    canvasDirtyRef.current = canvasDirty;
  }, [canvasDirty]);

  const updateLocation = useCallback((target?: { projectId?: string; draftId?: string }) => {
    const url = new URL(window.location.href);
    url.searchParams.set('notes', '1');
    url.searchParams.set('mode', 'canvas');
    if (target?.projectId) url.searchParams.set('canvasProject', target.projectId);
    else url.searchParams.delete('canvasProject');
    if (target?.draftId) url.searchParams.set('canvasDraft', target.draftId);
    else url.searchParams.delete('canvasDraft');
    window.history.replaceState(null, '', url);
  }, []);

  const refreshProjects = useCallback(async () => {
    if (projectsRefreshInFlightRef.current) return;
    projectsRefreshInFlightRef.current = true;
    setProjectsLoading(true);
    try {
      setProjects(await listCanvasProjects());
      setProjectsError('');
      setCanvasMessage((current) => /^(failed to fetch|networkerror\b)/i.test(current.trim()) ? '' : current);
    } catch (error) {
      setProjectsError(error instanceof Error ? error.message : '读取画布列表失败，正在自动重试。');
    } finally {
      projectsRefreshInFlightRef.current = false;
      setProjectsLoading(false);
    }
  }, []);

  const installCanvasDocument = useCallback((serverDocument: CanvasDocument) => {
    let document = serverDocument;
    let restoredLocalChanges = false;
    let conflictingRevision: number | null = null;
    const serverRemark = serverDocument.publishRemark ?? '';
    try {
      const savedDraft = localStorage.getItem(`kaoyan.canvas.draft.v1.${serverDocument.id}`);
      if (savedDraft) {
        const localDraft = parseCanvasDocument(savedDraft);
        const localRemark = localStorage.getItem(`${CANVAS_REMARK_KEY_PREFIX}${serverDocument.id}`)
          ?? localDraft.publishRemark
          ?? '';
        const localHasUnsavedContent = canvasSemanticFingerprint(localDraft, localRemark)
          !== canvasSemanticFingerprint(serverDocument, serverRemark);
        if (localDraft.id === serverDocument.id && localHasUnsavedContent) {
          document = localDraft;
          restoredLocalChanges = true;
          if (localDraft.syncRevision !== serverDocument.syncRevision) {
            conflictingRevision = serverDocument.syncRevision;
          }
        }
      }
    } catch {
      // Ignore an invalid local copy and keep the server project usable.
    }
    const localRemark = localStorage.getItem(`${CANVAS_REMARK_KEY_PREFIX}${serverDocument.id}`);
    const remark = document === serverDocument
      ? serverRemark
      : (localRemark ?? document.publishRemark ?? serverRemark);
    if (
      document !== serverDocument
      && localRemark !== null
      && localRemark !== serverRemark
    ) restoredLocalChanges = true;

    changeSequenceRef.current += 1;
    activeCanvasIdRef.current = document.id;
    syncedRevisionRef.current = serverDocument.syncRevision;
    canvasDirtyRef.current = restoredLocalChanges;
    setCanvasDocument(document);
    setCanvasRemark(remark);
    setSelectedProjectId(document.id);
    setCanvasDirty(restoredLocalChanges);
    setSyncConflict(conflictingRevision === null ? null : { actualRevision: conflictingRevision });
    setWorkspaceRevision((value) => value + 1);
    localStorage.removeItem(LAST_CANVAS_DRAFT_KEY);
    updateLocation({ projectId: document.id });
    return { document, restoredLocalChanges, syncConflict: conflictingRevision !== null };
  }, [updateLocation]);

  const openCanvasProject = useCallback(async (projectId: string, confirmDiscard = true) => {
    if (!projectId) return;
    if (confirmDiscard && canvasDirty && !window.confirm('当前画布有未保存修改。建议先按 Ctrl+S 保存工程；仍要打开另一个画布并离开这些修改吗？')) {
      return;
    }
    const requestSequence = ++openRequestSequenceRef.current;
    try {
      setCanvasMessage('正在打开可编辑画布工程…');
      const document = await loadCanvasProject(projectId);
      if (requestSequence !== openRequestSequenceRef.current) return;
      const installed = installCanvasDocument(document);
      setCanvasMessage(installed.syncConflict
        ? `已恢复“${installed.document.title || '未命名画布'}”的本机修改；另一台设备也有新版本，请选择保留哪一份。`
        : installed.restoredLocalChanges
          ? `已打开“${installed.document.title || '未命名画布'}”，并恢复了本机未保存修改。`
        : `已打开“${installed.document.title || '未命名画布'}”，可以继续编辑。`);
    } catch (error) {
      if (requestSequence !== openRequestSequenceRef.current) return;
      const localDraftKey = `kaoyan.canvas.draft.v1.${projectId}`;
      if (!confirmDiscard && SAFE_CANVAS_ID.test(projectId)) {
        const savedDraft = localStorage.getItem(localDraftKey);
        if (savedDraft) {
          try {
            const fallback = parseCanvasDocument(savedDraft);
            if (fallback.id !== projectId) throw new Error('草稿编号不一致。');
            changeSequenceRef.current += 1;
            activeCanvasIdRef.current = fallback.id;
            syncedRevisionRef.current = fallback.syncRevision;
            canvasDirtyRef.current = true;
            setCanvasDocument(fallback);
            setCanvasRemark(readCanvasRemark(fallback));
            setSelectedProjectId('');
            setCanvasDirty(true);
            setSyncConflict(null);
            setWorkspaceRevision((value) => value + 1);
            localStorage.setItem(LAST_CANVAS_DRAFT_KEY, projectId);
            updateLocation({ draftId: projectId });
            setCanvasMessage('服务端没有找到工程，已恢复这份本机草稿。请按 Ctrl+S 重新存入“我的画布”。');
            return;
          } catch {
            // Fall through to the original load error when the local copy is invalid.
          }
        }
      }
      setCanvasMessage(error instanceof Error ? error.message : '打开画布失败。');
    }
  }, [canvasDirty, installCanvasDocument, updateLocation]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (!projectsError) return undefined;
    const timer = window.setInterval(() => {
      void refreshProjects();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [projectsError, refreshProjects]);

  useEffect(() => {
    if (initialProjectAttemptedRef.current) return;
    initialProjectAttemptedRef.current = true;
    const projectId = new URLSearchParams(window.location.search).get('canvasProject');
    if (projectId) void openCanvasProject(projectId, false);
  }, [openCanvasProject]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('canvasProject')) return;
    localStorage.setItem(LAST_CANVAS_DRAFT_KEY, canvasDocument.id);
    updateLocation({ draftId: canvasDocument.id });
  }, [canvasDocument.id, updateLocation]);

  const persistCanvasDocument = useCallback(async (
    document: CanvasDocument,
    announce = true,
    options?: { expectedSequence?: number; remark?: string },
  ): Promise<CanvasDocument> => {
    if (persistInFlightRef.current) throw new Error('画布工程正在保存，请稍候。');
    const expectedSequence = options?.expectedSequence ?? changeSequenceRef.current;
    const remark = options?.remark ?? canvasRemark;
    const expectedRevision = syncedRevisionRef.current;
    const snapshot: CanvasDocument = { ...document, publishRemark: remark, syncRevision: expectedRevision };
    try {
      persistInFlightRef.current = true;
      setCanvasSaving(true);
      const result = await saveCanvasProject(snapshot, expectedRevision, canvasClientIdRef.current);
      const savedDocument = result.document!;
      syncedRevisionRef.current = savedDocument.syncRevision;
      workspaceRef.current?.acknowledgeSyncRevision(savedDocument.syncRevision);
      localStorage.setItem(`${CANVAS_REMARK_KEY_PREFIX}${savedDocument.id}`, remark);
      const changedWhileSaving = changeSequenceRef.current !== expectedSequence;
      const sameWorkspace = activeCanvasIdRef.current === savedDocument.id;
      if (sameWorkspace) {
        setSelectedProjectId(savedDocument.id);
        if (localStorage.getItem(LAST_CANVAS_DRAFT_KEY) === savedDocument.id) {
          localStorage.removeItem(LAST_CANVAS_DRAFT_KEY);
        }
        updateLocation({ projectId: savedDocument.id });
        if (!changedWhileSaving) {
          canvasDirtyRef.current = false;
          setCanvasDocument(savedDocument);
          setCanvasDirty(false);
        } else {
          canvasDirtyRef.current = true;
          setCanvasDirty(true);
        }
      }
      setSyncConflict(null);
      if (announce && sameWorkspace) setCanvasMessage(changedWhileSaving
          ? '请求开始时的版本已保存；保存期间的新修改仍待 Ctrl+S 保存。'
          : `可编辑工程“${savedDocument.title || '未命名画布'}”已保存；没有调用 AI。`);
      void refreshProjects();
      return savedDocument;
    } catch (error) {
      if (activeCanvasIdRef.current === snapshot.id) {
        if (error instanceof CanvasSyncConflictError) {
          setSyncConflict((current) => ({
            actualRevision: Math.max(current?.actualRevision ?? 0, error.actualRevision),
          }));
          canvasDirtyRef.current = true;
          setCanvasDirty(true);
          setCanvasMessage('另一台设备已更新这个画布。为避免覆盖，自动同步已暂停，请选择要保留的版本。');
        } else {
          setCanvasMessage(error instanceof Error ? error.message : '保存画布工程失败。');
        }
      }
      throw error;
    } finally {
      persistInFlightRef.current = false;
      setCanvasSaving(false);
    }
  }, [canvasRemark, refreshProjects, updateLocation]);

  const applyRemoteProjectRevision = useCallback(async (
    projectId: string,
    announcedRevision: number,
    discardLocalChanges = false,
  ): Promise<boolean> => {
    if (!projectId || activeCanvasIdRef.current !== projectId) return false;
    if (
      persistInFlightRef.current
      || workspaceRef.current?.isInteractionActive()
      || (!discardLocalChanges && canvasDirtyRef.current)
    ) {
      setSyncConflict((current) => ({
        actualRevision: Math.max(current?.actualRevision ?? 0, announcedRevision),
      }));
      setCanvasMessage('另一台设备已更新这个画布。当前设备也有操作，自动同步已暂停以免覆盖。');
      return false;
    }

    try {
      const remoteDocument = await loadCanvasProject(projectId);
      if (activeCanvasIdRef.current !== projectId) return false;
      if (remoteDocument.syncRevision < announcedRevision) return false;
      if (!discardLocalChanges && remoteDocument.syncRevision <= syncedRevisionRef.current) return true;
      if (!workspaceRef.current?.applyRemoteDocument(remoteDocument)) {
        setSyncConflict((current) => ({
          actualRevision: Math.max(current?.actualRevision ?? 0, remoteDocument.syncRevision),
        }));
        setCanvasMessage('检测到另一台设备的新版本；请先抬起 Apple Pencil 或结束文字编辑，再选择同步版本。');
        return false;
      }

      const remoteRemark = remoteDocument.publishRemark ?? '';
      changeSequenceRef.current += 1;
      syncedRevisionRef.current = remoteDocument.syncRevision;
      canvasDirtyRef.current = false;
      setCanvasDocument(remoteDocument);
      setCanvasRemark(remoteRemark);
      setCanvasDirty(false);
      setSyncConflict(null);
      setSelectedProjectId(remoteDocument.id);
      localStorage.setItem(`${CANVAS_REMARK_KEY_PREFIX}${remoteDocument.id}`, remoteRemark);
      setCanvasMessage('已实时同步另一台设备上的最新修改。');
      void refreshProjects();
      return true;
    } catch (error) {
      setCanvasMessage(error instanceof Error ? error.message : '同步另一台设备的修改失败。');
      return false;
    }
  }, [refreshProjects]);

  const relayLiveInkStroke = useCallback((stroke: CanvasInkStroke) => {
    void sendCanvasLiveStroke(activeCanvasIdRef.current, stroke, canvasClientIdRef.current).catch(() => {
      // The revisioned full-document autosave remains the reliable fallback.
    });
  }, []);

  useEffect(() => subscribeCanvasProjectEvents(
    (event: CanvasProjectEvent) => {
      if (event.sourceClientId === canvasClientIdRef.current) return;
      if (event.projectId !== activeCanvasIdRef.current) return;
      if (event.type === 'deleted') {
        canvasDirtyRef.current = false;
        setCanvasDirty(false);
        setSelectedProjectId('');
        setSyncConflict(null);
        localStorage.setItem(LAST_CANVAS_DRAFT_KEY, event.projectId);
        updateLocation({ draftId: event.projectId });
        setCanvasMessage('另一台设备删除了这个工程；当前内容暂留为本机草稿，可继续编辑或删除。');
        void refreshProjects();
        return;
      }
      if (event.type === 'live-stroke') {
        if (canvasDirtyRef.current || persistInFlightRef.current) return;
        workspaceRef.current?.applyRemoteInkStroke(event.stroke);
        return;
      }
      void refreshProjects();
      if (event.revision <= syncedRevisionRef.current) return;
      void applyRemoteProjectRevision(event.projectId, event.revision);
    },
    (connected) => {
      if (!connected || !selectedProjectId || canvasDirtyRef.current || persistInFlightRef.current) return;
      void loadCanvasProject(selectedProjectId).then((remoteDocument) => {
        if (remoteDocument.syncRevision <= syncedRevisionRef.current) return;
        return applyRemoteProjectRevision(selectedProjectId, remoteDocument.syncRevision);
      }).catch(() => undefined);
    },
  ), [applyRemoteProjectRevision, refreshProjects, selectedProjectId, updateLocation]);

  useEffect(() => {
    if (!canvasDirty || syncConflict || publishing || canvasDeleting) return undefined;
    const requestedProjectId = new URLSearchParams(window.location.search).get('canvasProject');
    if (requestedProjectId && selectedProjectId !== requestedProjectId) return undefined;
    const timer = window.setTimeout(() => {
      if (persistInFlightRef.current || publishingRef.current) return;
      const document = workspaceRef.current?.getDocument();
      if (!document || document.id !== activeCanvasIdRef.current) return;
      const expectedSequence = changeSequenceRef.current;
      void persistCanvasDocument(document, false, { expectedSequence, remark: canvasRemark }).catch(() => undefined);
    }, canvasSaving ? 650 : 180);
    return () => window.clearTimeout(timer);
  }, [canvasDeleting, canvasDirty, canvasDocument, canvasRemark, canvasSaving, persistCanvasDocument, publishing, selectedProjectId, syncConflict]);

  const useRemoteCanvasVersion = useCallback(() => {
    if (!syncConflict) return;
    void applyRemoteProjectRevision(activeCanvasIdRef.current, syncConflict.actualRevision, true);
  }, [applyRemoteProjectRevision, syncConflict]);

  const keepLocalCanvasVersion = useCallback(() => {
    if (!syncConflict) return;
    syncedRevisionRef.current = syncConflict.actualRevision;
    workspaceRef.current?.acknowledgeSyncRevision(syncConflict.actualRevision);
    canvasDirtyRef.current = true;
    setCanvasDirty(true);
    setSyncConflict(null);
    setCanvasMessage('将保留本机版本；正在把它同步到其他设备。');
  }, [syncConflict]);

  const removeLocalCanvasData = (canvasId: string) => {
    localStorage.removeItem(`kaoyan.canvas.draft.v1.${canvasId}`);
    localStorage.removeItem(`${CANVAS_REMARK_KEY_PREFIX}${canvasId}`);
    if (localStorage.getItem(LAST_CANVAS_DRAFT_KEY) === canvasId) {
      localStorage.removeItem(LAST_CANVAS_DRAFT_KEY);
    }
  };

  const resetToBlankCanvas = (message: string) => {
    openRequestSequenceRef.current += 1;
    const document = createEmptyCanvasDocument('未命名画布');
    changeSequenceRef.current += 1;
    activeCanvasIdRef.current = document.id;
    syncedRevisionRef.current = document.syncRevision;
    canvasDirtyRef.current = false;
    lastPublishedFingerprintRef.current = null;
    publishOperationRef.current = null;
    setCanvasDocument(document);
    setSelectedProjectId('');
    setCanvasDirty(false);
    setSyncConflict(null);
    setCanvasRemark('');
    setWorkspaceRevision((value) => value + 1);
    setCanvasMessage(message);
    localStorage.setItem(LAST_CANVAS_DRAFT_KEY, document.id);
    localStorage.setItem(`${CANVAS_REMARK_KEY_PREFIX}${document.id}`, '');
    updateLocation({ draftId: document.id });
  };

  const createNewCanvas = () => {
    if (canvasDirty && !window.confirm('当前画布有未保存修改。建议先按 Ctrl+S 保存工程；仍要新建并离开这些修改吗？')) {
      return;
    }
    resetToBlankCanvas('已新建空白画布。拖入图片，或按 I 选择图片。');
  };

  const deleteCurrentCanvas = async () => {
    if (canvasDeleting || canvasSaving || publishing) return;
    const document = workspaceRef.current?.getDocument() ?? canvasDocument;
    const label = document.title || '未命名画布';
    if (selectedProjectId) {
      if (!window.confirm(`确定删除画布工程“${label}”吗？删除后不会再出现在“我的画布”中。`)) return;
      const wasDirty = canvasDirtyRef.current;
      try {
        setCanvasDeleting(true);
        canvasDirtyRef.current = false;
        setCanvasDirty(false);
        await deleteCanvasProject(selectedProjectId, syncedRevisionRef.current, canvasClientIdRef.current);
        removeLocalCanvasData(selectedProjectId);
        resetToBlankCanvas(`已删除“${label}”。工程已移到本机回收目录，需要时仍可恢复。`);
        await refreshProjects();
      } catch (error) {
        canvasDirtyRef.current = wasDirty;
        setCanvasDirty(wasDirty);
        setCanvasMessage(error instanceof Error ? error.message : '删除画布工程失败。');
      } finally {
        setCanvasDeleting(false);
      }
      return;
    }
    if (!window.confirm(`确定删除未保存画布“${label}”吗？这会清除这台设备上的草稿。`)) return;
    removeLocalCanvasData(document.id);
    resetToBlankCanvas(`已删除未保存画布“${label}”。`);
  };

  const publishCanvas = async () => {
    if (publishingRef.current) return;
    const document = workspaceRef.current?.getDocument();
    if (!document || !hasCanvasContent(document)) {
      setCanvasMessage('画布还是空的，先加入图片、文字或批注。');
      return;
    }
    const completionIssues = getCanvasCompletionIssues(document);
    if (completionIssues.length > 0) {
      setCanvasMessage(`还不能存入笔记：${completionIssues.join('；')}。Ctrl+S 仍可保存这份草稿。`);
      return;
    }
    const publishRemark = canvasRemark;
    const expectedSequence = changeSequenceRef.current;
    const fingerprint = canvasSemanticFingerprint(document, publishRemark);
    if (
      lastPublishedFingerprintRef.current === fingerprint
      && !window.confirm('这份画布发布后没有修改。确定要再次存入笔记吗？')
    ) return;

    if (publishOperationRef.current?.fingerprint !== fingerprint) {
      publishOperationRef.current = { fingerprint, noteUid: createNoteUid() };
    }
    const publishNoteUid = publishOperationRef.current.noteUid;

    try {
      publishingRef.current = true;
      setPublishing(true);
      setCanvasMessage('正在保存工程并生成笔记预览图…');
      const savedDocument = await persistCanvasDocument(document, false, { expectedSequence, remark: publishRemark });
      const preview = await renderCanvasPreview(savedDocument);
      const imageDataUrl = await blobToDataUrl(preview);
      const result = await saveNoteImage({
        imageDataUrl,
        kind: 'canvas',
        noteUid: publishNoteUid,
        remark: publishRemark,
        canvasProjectId: savedDocument.id,
      });
      lastPublishedFingerprintRef.current = fingerprint;
      publishOperationRef.current = null;
      if (activeCanvasIdRef.current === document.id) {
        setCanvasMessage(changeSequenceRef.current === expectedSequence
          ? `已存入笔记：${result.filePath ?? result.fileName ?? ''}。原画布仍可继续编辑。`
          : `已存入笔记：${result.filePath ?? result.fileName ?? ''}。发布期间的新修改仍待 Ctrl+S 保存。`);
      }
    } catch (error) {
      if (activeCanvasIdRef.current === document.id) {
        setCanvasMessage(error instanceof Error ? error.message : '画布存入笔记失败。');
      }
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  };

  const updateCanvasRemark = (value: string) => {
    changeSequenceRef.current += 1;
    setCanvasRemark(value);
    canvasDirtyRef.current = true;
    setCanvasDirty(true);
    localStorage.setItem(`${CANVAS_REMARK_KEY_PREFIX}${canvasDocument.id}`, value);
  };

  const handleCanvasShellKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    const target = event.target as HTMLElement;
    if (target.closest('.canvas-workspace')) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const document = workspaceRef.current?.getDocument();
    if (!document) return;
    const expectedSequence = changeSequenceRef.current;
    void persistCanvasDocument(document, true, { expectedSequence, remark: canvasRemark }).catch(() => undefined);
  };

  const selectedMissingFromList = selectedProjectId && !projects.some((project) => project.id === selectedProjectId);
  const visibleMessage = projectsError || canvasMessage;
  return (
    <main
      className="note-capture-page canvas-mode"
      onKeyDownCapture={handleCanvasShellKeyDownCapture}
    >
      <header className="note-app-bar">
        <div className="note-app-identity"><Clipboard size={16} aria-hidden="true" /><strong>画布</strong></div>
        {visibleMessage && <p className="note-app-status" title={visibleMessage} aria-live="polite">{visibleMessage}</p>}
      </header>

      <section className="note-capture-layout is-canvas">
          <section className="canvas-project-shell">
            <div className="canvas-project-bar">
              <button type="button" onClick={createNewCanvas} disabled={canvasSaving || canvasDeleting || publishing}><Plus size={15} /> 新建画布</button>
              <label className="canvas-project-picker">
                <FolderOpen size={16} />
                <select
                  aria-label="打开我的画布"
                  value={selectedProjectId}
                  disabled={projectsLoading || canvasSaving || canvasDeleting || publishing}
                  onChange={(event) => {
                    const projectId = event.target.value;
                    if (projectId) void openCanvasProject(projectId);
                    else createNewCanvas();
                  }}
                >
                  <option value="">我的画布：当前未保存</option>
                  {selectedMissingFromList && <option value={selectedProjectId}>当前工程</option>}
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title || '未命名画布'} · {project.strokeCount ?? 0} 笔 · {project.imageCount} 图 · {formatProjectTime(project.updatedAt)}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => void refreshProjects()} disabled={projectsLoading} title="刷新我的画布">
                <RefreshCw size={15} className={projectsLoading ? 'is-spinning' : ''} /> 刷新
              </button>
              <button className="canvas-delete-button" type="button" onClick={() => void deleteCurrentCanvas()} disabled={canvasSaving || canvasDeleting || publishing} title={selectedProjectId ? '删除当前工程' : '删除当前未保存草稿'}>
                <Trash2 size={15} /> {canvasDeleting ? '删除中' : '删除'}
              </button>
              <div className="canvas-project-state" aria-live="polite">
                {selectedProjectId && (
                  <span className={canvasDirty || syncConflict ? 'is-dirty' : ''}>
                    {canvasSaving
                      ? '工程保存中'
                      : syncConflict
                        ? '检测到跨设备冲突'
                        : canvasDirty
                          ? '等待自动同步'
                          : '工程已实时同步'}
                  </span>
                )}
                {syncConflict && (
                  <>
                    <button type="button" onClick={useRemoteCanvasVersion} disabled={canvasSaving}>载入另一设备</button>
                    <button type="button" onClick={keepLocalCanvasVersion} disabled={canvasSaving}>保留本机版本</button>
                  </>
                )}
                {draftStatus === 'failed' && <span className="is-error">本机草稿空间不足，请按 Ctrl+S 保存工程</span>}
              </div>
            </div>

            <CanvasWorkspace
              key={`${canvasDocument.id}:${workspaceRevision}`}
              ref={workspaceRef}
              initialDocument={canvasDocument}
              draftKey={`kaoyan.canvas.draft.v1.${canvasDocument.id}`}
              onInkStrokePreview={relayLiveInkStroke}
              onInkStrokeCommit={relayLiveInkStroke}
              onChange={(document) => {
                changeSequenceRef.current += 1;
                if (activeCanvasIdRef.current !== document.id) {
                  openRequestSequenceRef.current += 1;
                  activeCanvasIdRef.current = document.id;
                  setSelectedProjectId('');
                  localStorage.setItem(LAST_CANVAS_DRAFT_KEY, document.id);
                  updateLocation({ draftId: document.id });
                }
                setCanvasDocument(document);
                canvasDirtyRef.current = true;
                setCanvasDirty(true);
                if (!selectedProjectId) localStorage.setItem(LAST_CANVAS_DRAFT_KEY, document.id);
              }}
              onSave={async (document) => {
                const expectedSequence = changeSequenceRef.current;
                await persistCanvasDocument(document, true, { expectedSequence, remark: canvasRemark });
              }}
              onError={(error) => setCanvasMessage(error.message)}
              onDraftStatus={setDraftStatus}
            />

            <section className="canvas-publish-panel">
              <label htmlFor="canvas-publish-remark">画布备注</label>
              <textarea
                id="canvas-publish-remark"
                value={canvasRemark}
                onChange={(event) => updateCanvasRemark(event.target.value)}
                placeholder="补充页码、错因或需要记住的内容（可选）"
              />
              <button className="note-primary-button" title="生成整张画布预览并交给 AI 整理" type="button" onClick={() => void publishCanvas()} disabled={publishing || canvasSaving}>
                <Sparkles size={15} /> {publishing ? '正在存入笔记' : '完成并存入笔记'}
              </button>
            </section>
          </section>
        </section>
    </main>
  );
}
