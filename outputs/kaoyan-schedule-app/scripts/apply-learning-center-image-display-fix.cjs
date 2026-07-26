'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'src/components/LearningCenter.tsx');
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(search, replacement, label) {
  if (source.includes(replacement)) return;
  const next = source.replace(search, replacement);
  if (next === source) throw new Error(`Patch target not found: ${label}`);
  source = next;
}

replaceOnce(
  "  LearningAutoNote,\n  LearningCard,",
  "  LearningAttachment,\n  LearningAutoNote,\n  LearningCard,",
  'LearningAttachment import',
);

replaceOnce(
  "const noteFileUrl = (filePath: string): string => `${NOTE_SERVER_URL}/note-file?path=${encodeURIComponent(filePath)}`;",
  `const noteFileUrl = (filePath: string): string => \`${NOTE_SERVER_URL}/note-file?path=\${encodeURIComponent(filePath)}\`;

const normalizeLearningAssetPath = (value: string): string => value.trim().split('\\\\').join('/');
const isStableLearningAssetPath = (value: string): boolean => /^(?:github:\/\/data\/assets\/|data\/assets\/|r2:\/\/note-assets\/)/i.test(normalizeLearningAssetPath(value));

const learningAttachmentExtension = (attachment: LearningAttachment): string => {
  const nameExtension = attachment.name.toLowerCase().match(/\\.([a-z0-9]+)$/)?.[1];
  const pathExtension = normalizeLearningAssetPath(attachment.filePath).toLowerCase().match(/\\.([a-z0-9]+)$/)?.[1];
  if (nameExtension || pathExtension) return nameExtension || pathExtension || 'jpg';
  if (attachment.mimeType === 'image/png') return 'png';
  if (attachment.mimeType === 'image/webp') return 'webp';
  if (attachment.mimeType === 'image/gif') return 'gif';
  if (attachment.mimeType === 'image/avif') return 'avif';
  if (attachment.mimeType === 'image/heic') return 'heic';
  if (attachment.mimeType === 'image/heif') return 'heif';
  return 'jpg';
};

const stableLearningAttachmentPath = (note: LearningAutoNote, attachment: LearningAttachment): string => {
  const current = normalizeLearningAssetPath(attachment.filePath);
  if (isStableLearningAssetPath(current)) return current;
  const materialIndex = /^material-(\\d+)$/.exec(attachment.id)?.[1];
  if (materialIndex) {
    return \`github://data/assets/\${note.noteUid}/\${materialIndex.padStart(2, '0')}-\${attachment.name}\`;
  }
  if (attachment.kind === 'image') {
    return \`github://data/assets/\${note.noteUid}.\${learningAttachmentExtension(attachment)}\`;
  }
  const baseName = current.split('/').filter(Boolean).at(-1) || attachment.name;
  return baseName ? \`github://data/assets/\${baseName}\` : '';
};

const noteAttachmentPaths = (note: LearningAutoNote, attachment: LearningAttachment): string[] => {
  const current = attachment.filePath.trim();
  const stable = stableLearningAttachmentPath(note, attachment);
  return uniqueText(IS_CLOUD_RUNTIME ? [stable, current] : [current, stable]);
};

const noteAttachmentPrimaryPath = (note: LearningAutoNote, attachment: LearningAttachment): string => (
  noteAttachmentPaths(note, attachment)[0] || attachment.filePath
);

interface ResilientNoteImageProps {
  paths: string[];
  alt: string;
  loading?: 'eager' | 'lazy';
  onUnavailable?: () => void;
}

function ResilientNoteImage({ paths, alt, loading = 'lazy', onUnavailable }: ResilientNoteImageProps) {
  const usablePaths = uniqueText(paths);
  const pathKey = usablePaths.join('\\n');
  const [pathIndex, setPathIndex] = useState(0);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    setPathIndex(0);
    setExhausted(false);
  }, [pathKey]);

  const filePath = usablePaths[pathIndex] || '';
  if (!filePath || exhausted) return null;
  return (
    <img
      src={noteFileUrl(filePath)}
      alt={alt}
      loading={loading}
      decoding="async"
      onError={() => {
        if (pathIndex + 1 < usablePaths.length) {
          setPathIndex((current) => current + 1);
          return;
        }
        setExhausted(true);
        onUnavailable?.();
      }}
    />
  );
}`,
  'learning asset resolver',
);

replaceOnce(
  "  const indexedNotes = useMemo(() => allNotes.filter(({ note }) => isKnowledgeEligibleNote(note)), [allNotes]);",
  `  const notesByUid = useMemo(() => new Map(allNotes.map(({ note }) => [note.noteUid, note])), [allNotes]);
  const resolveCardImagePath = (card: LearningCard): string => {
    const note = notesByUid.get(card.noteUid);
    const attachment = note ? noteImageAttachment(note) : null;
    if (note && attachment) return noteAttachmentPrimaryPath(note, attachment);
    return card.sourceFilePath || '';
  };
  const currentCardResolvedPath = currentCard ? resolveCardImagePath(currentCard) : '';
  const indexedNotes = useMemo(() => allNotes.filter(({ note }) => isKnowledgeEligibleNote(note)), [allNotes]);`,
  'card image resolver',
);

replaceOnce(
  "       src: noteFileUrl(attachment.filePath),",
  "       src: noteFileUrl(noteAttachmentPrimaryPath(note, attachment)),",
  'note viewer path',
);

replaceOnce(
  `    const items = reviewCards.filter((item) => Boolean(item.sourceFilePath)).map((item) => ({
      id: \`card:\${item.id}\`,
      src: \`\${NOTE_SERVER_URL}/note-file?path=\${encodeURIComponent(item.sourceFilePath)}\`,
      alt: \`\${item.sourceTitle || item.front || '复习卡'}原图\`,
    }));`,
  `    const items: ImageViewerItem[] = [];
    reviewCards.forEach((item) => {
      const filePath = resolveCardImagePath(item);
      if (!filePath) return;
      items.push({
        id: \`card:\${item.id}\`,
        src: noteFileUrl(filePath),
        alt: \`\${item.sourceTitle || item.front || '复习卡'}原图\`,
      });
    });`,
  'card viewer path',
);

replaceOnce(
  `    const thumbnailAttachment = noteImageAttachment(note);
    const thumbnailUrl = thumbnailAttachment?.filePath ? noteFileUrl(thumbnailAttachment.filePath) : '';`,
  `    const thumbnailAttachment = noteImageAttachment(note);
    const thumbnailPaths = thumbnailAttachment ? noteAttachmentPaths(note, thumbnailAttachment) : [];`,
  'thumbnail candidates',
);

replaceOnce(
  `          {thumbnailUrl && (
            <img
              src={thumbnailUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onError={(event) => { event.currentTarget.hidden = true; }}
            />
          )}`,
  `          {thumbnailPaths.length > 0 && <ResilientNoteImage paths={thumbnailPaths} alt="" />}`,
  'thumbnail fallback renderer',
);

replaceOnce(
  `    const imageAttachment = noteImageAttachment(note);
    const imagePath = imageAttachment?.filePath || '';
    const imageUrl = imagePath ? noteFileUrl(imagePath) : '';`,
  `    const imageAttachment = noteImageAttachment(note);
    const imagePaths = imageAttachment ? noteAttachmentPaths(note, imageAttachment) : [];
    const imagePath = imagePaths[0] || '';`,
  'detail image candidates',
);

replaceOnce(
  `    const sourcePreview = imagePath ? (
      <figure className="lc-source-preview is-question-first">
        {imageUrl && failedImagePath !== imagePath ? (
          <button
            className="lc-source-preview-open"
            type="button"
            onClick={() => openNoteViewer(note, context)}
            aria-label="打开原图"
          >
            <img src={imageUrl} alt={\`\${note.title || '笔记'}原图\`} loading="eager" decoding="async" onError={() => setFailedImagePath(imagePath)} />
            <span aria-hidden="true"><ZoomIn size={16} /></span>
          </button>
        ) : (
          <div>
            <FileImage size={28} />
            <strong>原图加载失败</strong>
            {failedImagePath === imagePath && (
              <button type="button" onClick={() => {
                setFailedImagePath('');
              }}>重试</button>
            )}
          </div>
        )}
      </figure>
    ) : null;`,
  `    const sourcePreview = imagePath ? (
      <figure className="lc-source-preview is-question-first">
        {failedImagePath !== imagePath ? (
          <button
            className="lc-source-preview-open"
            type="button"
            onClick={() => openNoteViewer(note, context)}
            aria-label="打开原图"
          >
            <ResilientNoteImage
              paths={imagePaths}
              alt={\`\${note.title || '笔记'}原图\`}
              loading="eager"
              onUnavailable={() => setFailedImagePath(imagePath)}
            />
            <span aria-hidden="true"><ZoomIn size={16} /></span>
          </button>
        ) : (
          <div>
            <FileImage size={28} />
            <strong>原图加载失败</strong>
            <button type="button" onClick={() => setFailedImagePath('')}>重试</button>
          </div>
        )}
      </figure>
    ) : null;`,
  'detail fallback renderer',
);

source = source.replaceAll(
  "href={noteFileUrl(attachment.filePath)}",
  "href={noteFileUrl(noteAttachmentPrimaryPath(note, attachment))}",
);

source = source.replaceAll('currentCard.sourceFilePath', 'currentCardResolvedPath');
source = source.replace(
  "src={`${NOTE_SERVER_URL}/note-file?path=${encodeURIComponent(currentCardResolvedPath)}`}",
  "src={noteFileUrl(currentCardResolvedPath)}",
);

if (source.includes('event.currentTarget.hidden = true')) throw new Error('legacy hidden-on-error thumbnail behavior still exists');
if (!source.includes('github://data/assets/${note.noteUid}')) throw new Error('stable noteUid asset path missing');

fs.writeFileSync(file, source, 'utf8');

const testFile = path.join(root, 'scripts/learning-center-image-display.test.cjs');
fs.writeFileSync(testFile, `'use strict';\n\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst test = require('node:test');\n\nconst root = path.resolve(__dirname, '..');\nconst source = fs.readFileSync(path.join(root, 'src/components/LearningCenter.tsx'), 'utf8');\n\ntest('legacy note images use stable noteUid assets in cloud runtime', () => {\n  assert.match(source, /github:\\/\\/data\\/assets\\/\\$\\{note\\.noteUid\\}/);\n  assert.match(source, /IS_CLOUD_RUNTIME \\? \\[stable, current\\] : \\[current, stable\\]/);\n});\n\ntest('all learning-center image surfaces use the shared resolver', () => {\n  assert.match(source, /ResilientNoteImage paths=\\{thumbnailPaths\\}/);\n  assert.match(source, /noteAttachmentPrimaryPath\\(note, attachment\\)/);\n  assert.match(source, /resolveCardImagePath\\(item\\)/);\n  assert.match(source, /currentCardResolvedPath/);\n});\n\ntest('failed thumbnails try fallback paths instead of being permanently hidden', () => {\n  assert.match(source, /pathIndex \\+ 1 < usablePaths\\.length/);\n  assert.doesNotMatch(source, /event\\.currentTarget\\.hidden = true/);\n});\n`);

console.log('learning center image display fix applied');
