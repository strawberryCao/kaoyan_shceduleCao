const fs = require('fs');
const path = require('path');

if (process.env.GITHUB_ACTIONS === 'true') {
  const file = path.join(__dirname, 'ensure-source-invariants.cjs');
  let source = fs.readFileSync(file, 'utf8');
  const search = "  return `${source.slice(0, blockStart)}${replacement}${source.slice(blockEnd)}`;";
  const replacement = [
    "  const normalizedReplacement = replacement.split('\\\\`').join('`');",
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
