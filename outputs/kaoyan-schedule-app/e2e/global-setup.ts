import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';

const waitFor = async (url: string) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
};

export default async function globalSetup() {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const noteEnvironment = { ...process.env };
  for (const key of ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'GEMINI_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY']) {
    delete noteEnvironment[key];
  }
  const noteProcess = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'e2e-note-server.cjs')], {
    cwd: projectRoot,
    env: noteEnvironment,
    stdio: 'inherit',
  });
  const workerModule = await import('../scripts/e2e-worker-server.mjs');
  const vite = await createViteServer({
    configFile: fileURLToPath(new URL('../vite.config.mjs', import.meta.url)),
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
  });
  await vite.listen();
  await Promise.all([
    waitFor('http://127.0.0.1:5173/?noteApp=1'),
    waitFor('http://127.0.0.1:5174/health'),
    waitFor('http://127.0.0.1:8787/api/auth/status'),
  ]);

  return async () => {
    if (!noteProcess.killed) noteProcess.kill();
    await Promise.allSettled([
      vite.close(),
      workerModule.close(),
    ]);
  };
}
