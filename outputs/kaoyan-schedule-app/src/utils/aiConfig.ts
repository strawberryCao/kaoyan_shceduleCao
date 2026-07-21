import { NOTE_SERVER_URL } from './notes';

export type AiTaskDifficulty = 'low' | 'medium' | 'high';

export interface AiNamingRule {
  id: string;
  name: string;
  enabled: boolean;
  when: string;
  extract: string;
  titleTemplate: string;
  validationHint?: string;
}

export interface AiTaskSettings {
  enabled?: boolean;
  providerId?: string;
  modelId?: string;
  fallback?: boolean;
  difficulty?: AiTaskDifficulty;
  temperature?: number;
  timeoutMs?: number;
  customInstructions?: string;
  namingRules?: AiNamingRule[];
  options?: Record<string, string | number | boolean>;
}

export interface AiTaskParameterDefinition {
  id: string;
  group: string;
  type: 'boolean' | 'number' | 'select' | 'text' | 'path';
  label: string;
  description: string;
  default: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  maxLength?: number;
  options?: Array<{ value: string; label: string }>;
}

export interface AiTaskDefinition {
  id: string;
  label: string;
  description: string;
  active: boolean;
  defaults: {
    difficulty: AiTaskDifficulty;
    capabilities: string[];
    timeoutMs?: number;
  };
  parameters: AiTaskParameterDefinition[];
}

export interface AiProviderModelStatus {
  id: string;
  capabilities: string[];
  costTier: number;
  qualityTier: number;
  catalogOnly?: boolean;
}

export interface AiProviderStatus {
  id: string;
  enabled: boolean;
  models: AiProviderModelStatus[];
  circuit: {
    open: boolean;
    consecutiveFailures: number;
    openUntil: number | null;
  };
}

export interface AiConfigurationSnapshot {
  ok: true;
  updatedAt: string | null;
  taskDefinitions: AiTaskDefinition[];
  tasks: Record<string, AiTaskSettings>;
  providers: AiProviderStatus[];
  routing: {
    timeoutMs: number;
    circuitThreshold: number;
    circuitCooldownMs: number;
    networkRetries: number;
    jsonRepairRetries: number;
  };
  error: string | null;
}

async function readResponse(response: Response): Promise<AiConfigurationSnapshot> {
  const payload = await response.json().catch(() => null) as (AiConfigurationSnapshot & { error?: string }) | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `AI 配置服务请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

export async function fetchAiConfiguration(): Promise<AiConfigurationSnapshot> {
  const response = await fetch(`${NOTE_SERVER_URL}/ai/config`, { cache: 'no-store' });
  return readResponse(response);
}

export async function saveAiConfiguration(
  tasks: Record<string, AiTaskSettings>,
): Promise<AiConfigurationSnapshot> {
  const response = await fetch(`${NOTE_SERVER_URL}/ai/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks }),
  });
  return readResponse(response);
}


export interface ReviewSyncStatus {
  ok?: boolean;
  running?: boolean;
  updatedAt?: string;
  lastPushAt?: string;
  lastPushCount?: number;
  lastPushResult?: string;
  lastPullAt?: string;
  lastPullResult?: string;
  lastRemoteGeneratedAt?: string;
  lastError?: string | null;
  settings?: {
    enabled?: boolean;
    repository?: string;
    branch?: string;
    outputDirectory?: string;
  };
}

async function readReviewResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !payload) throw new Error(payload?.error || `综合复习同步请求失败（HTTP ${response.status}）`);
  return payload;
}

export async function fetchReviewSyncStatus(): Promise<ReviewSyncStatus> {
  return readReviewResponse<ReviewSyncStatus>(await fetch(`${NOTE_SERVER_URL}/ai/review/status`, { cache: 'no-store' }));
}

export async function pushReviewData(): Promise<{ ok: boolean; changed?: boolean; count?: number; skipped?: boolean; reason?: string }> {
  return readReviewResponse(await fetch(`${NOTE_SERVER_URL}/ai/review/push`, { method: 'POST' }));
}

export async function pullReviewPdfs(): Promise<{ ok: boolean; downloaded?: number; outputDirectory?: string; skipped?: boolean; reason?: string }> {
  return readReviewResponse(await fetch(`${NOTE_SERVER_URL}/ai/review/pull`, { method: 'POST' }));
}

export async function selectReviewOutputDirectory(initialPath = ''): Promise<{ ok: boolean; path: string; cancelled?: boolean }> {
  return readReviewResponse(await fetch(`${NOTE_SERVER_URL}/ai/review/select-directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initialPath }),
  }));
}
