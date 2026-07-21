const { runProviderTest } = require('./test-ai-provider.cjs');

runProviderTest(process.env.KAOYAN_AI_PROVIDER || 'gemini').catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

