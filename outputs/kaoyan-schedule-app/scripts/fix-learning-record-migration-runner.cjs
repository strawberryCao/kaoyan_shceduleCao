const fs = require('fs');
const path = require('path');

if (process.env.GITHUB_ACTIONS === 'true') {
  const appRoot = path.resolve(__dirname, '..');
  const migrationMarker = path.join(__dirname, '.apply-real-learning-records-v1');
  const storePath = path.join(__dirname, 'learning-data-store.cjs');
  const clientPath = path.join(appRoot, 'src', 'utils', 'learningData.ts');
  const cloudMediaPath = path.join(appRoot, 'cloudflare', 'media.js');
  const noteDropPath = path.join(appRoot, 'src', 'components', 'QuickMaterialComposer.tsx');
  const sources = [storePath, clientPath, cloudMediaPath, noteDropPath]
    .map((filePath) => fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '');
  const modernLearningRecordsArePresent = sources[0].includes('attachments: normalizeAttachments')
    && sources[0].includes('facets: normalizeFacets')
    && sources[1].includes('export interface LearningAttachment')
    && sources[2].includes('export async function saveMaterialNote')
    && sources[3].includes('export function QuickMaterialComposer');

  if (modernLearningRecordsArePresent) {
    // The marker belongs to the one-time v1 migration. Running that historical
    // patch over the current attachment-aware schema would try to reapply old
    // string replacements and fail during npm ci. Remove it only from the CI
    // worktree; the committed marker remains available to genuinely old refs.
    fs.rmSync(migrationMarker, { force: true });
    console.log('Modern learning-record sources detected; skipped the obsolete v1 migration.');
  } else {
    const file = path.join(__dirname, 'ensure-source-invariants.cjs');
    let source = fs.readFileSync(file, 'utf8');
    const search = "  return `${source.slice(0, blockStart)}${replacement}${source.slice(blockEnd)}`;";
    const replacement = [
      "  const normalizedReplacement = replacement.split('\\`').join('`');",
      "  return `${source.slice(0, blockStart)}${normalizedReplacement}${source.slice(blockEnd)}`;",
    ].join('\n');
    if (!source.includes('const normalizedReplacement = replacement.split')) {
      if (!source.includes(search)) {
        throw new Error('Migration replacement normalization anchor was not found.');
      }
      source = source.replace(search, replacement);
      fs.writeFileSync(file, source, 'utf8');
    }
  }
}
