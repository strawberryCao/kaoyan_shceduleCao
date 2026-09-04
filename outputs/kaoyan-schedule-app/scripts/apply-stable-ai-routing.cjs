const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteJson } = require('./note-taxonomy.cjs');

const assistantRoot = path.resolve(process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手'));
const configPath = path.resolve(process.env.KAOYAN_AI_CONFIG_PATH || path.join(assistantRoot, 'ai-providers.json'));

function configuredProvider(config, id) {
  if (Array.isArray(config.providers)) return config.providers.find((provider) => provider?.id === id);
  return config.providers?.[id] ? { id, ...config.providers[id] } : null;
}

function selectModel(provider, preferredIds, requiredCapability) {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  const supports = (model) => !requiredCapability
    || !Array.isArray(model?.capabilities)
    || model.capabilities.includes(requiredCapability);
  for (const id of preferredIds) {
    const exact = models.find((model) => String(model?.id || model?.model || '') === id && supports(model));
    if (exact) return String(exact.id || exact.model);
  }
  const candidate = models
    .filter(supports)
    .sort((left, right) => Number(right?.qualityTier || 0) - Number(left?.qualityTier || 0))[0];
  return String(candidate?.id || candidate?.model || provider?.model || provider?.defaultModel || '');
}

if (!fs.existsSync(configPath)) throw new Error(`AI config not found: ${configPath}`);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const kimi = configuredProvider(config, 'kimi');
const deepseek = configuredProvider(config, 'deepseek');
if (!kimi || kimi.enabled === false || !String(kimi.apiKey || '').trim()) throw new Error('Enabled Kimi provider with API key is required');
if (!deepseek || deepseek.enabled === false || !String(deepseek.apiKey || '').trim()) throw new Error('Enabled DeepSeek provider with API key is required');
const kimiVisionModel = selectModel(kimi, ['kimi-k3', 'kimi-k2.6'], 'vision');
const deepseekReasoningModel = String(
  config.tasks?.note_enrichment?.modelId
  || selectModel(deepseek, ['deepseek-v4-pro', 'deepseek-v4-flash'], 'text')
  || deepseek.model
  || '',
);
if (!kimiVisionModel || !deepseekReasoningModel) throw new Error('Required Kimi vision or DeepSeek reasoning model is not configured');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(assistantRoot, 'repair-backups', `${stamp}-ai-routing`);
fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(configPath, path.join(backupDir, path.basename(configPath)));

const tasks = { ...(config.tasks || {}) };
const withTask = (taskId, providerId, modelId, options = {}) => ({
  ...(tasks[taskId] || {}),
  enabled: true,
  providerId,
  modelId,
  fallback: true,
  options: { ...(tasks[taskId]?.options || {}), ...options },
});
tasks.note_naming = withTask('note_naming', 'kimi', kimiVisionModel);
tasks.material_naming = withTask('material_naming', 'kimi', kimiVisionModel);
tasks.note_image_understanding = withTask('note_image_understanding', 'kimi', kimiVisionModel, { reasoningMode: 'balanced' });
tasks.note_enrichment = withTask('note_enrichment', 'deepseek', deepseekReasoningModel, {
  collaborationMode: 'vision_then_reasoning',
});
tasks.taxonomy = withTask('taxonomy', 'deepseek', deepseekReasoningModel, { wrongReasonGroupCount: 6 });

atomicWriteJson(configPath, { ...config, tasks });
console.log(JSON.stringify({
  ok: true,
  configPath,
  backupDir,
  routing: {
    note_naming: `kimi/${kimiVisionModel}`,
    material_naming: `kimi/${kimiVisionModel}`,
    note_image_understanding: `kimi/${kimiVisionModel}`,
    note_enrichment: `deepseek/${deepseekReasoningModel}`,
    collaborationMode: 'vision_then_reasoning',
    wrongReasonGroupCount: 6,
  },
}, null, 2));
