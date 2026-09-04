export const EXPLICIT_AI_ACTION_HEADER = 'X-Kaoyan-AI-Action';

export const explicitAiActionHeaders = (json = true): Record<string, string> => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  [EXPLICIT_AI_ACTION_HEADER]: 'user',
});
