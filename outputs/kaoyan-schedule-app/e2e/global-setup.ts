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
  const appPort = 15173;
  const notePort = 15174;
  const workerPort = 18787;
  const noteEnvironment = { ...process.env };
  noteEnvironment.KAOYAN_E2E_NOTE_PORT = String(notePort);
  process.env.KAOYAN_E2E_WORKER_PORT = String(workerPort);
  process.env.VITE_NOTE_SERVER_URL = '/api';
  process.env.VITE_DEV_NOTE_SERVER_TARGET = `http://127.0.0.1:${notePort}`;
  process.env.VITE_DEV_APP_ORIGIN = 'http://127.0.0.1:5173';
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
      port: appPort,
      strictPort: true,
    },
  });
  await vite.listen();
  await Promise.all([
    waitFor(`http://127.0.0.1:${appPort}/?noteApp=1`),
    waitFor(`http://127.0.0.1:${notePort}/health`),
    waitFor(`http://127.0.0.1:${workerPort}/api/auth/status`),
  ]);

  return async () => {
    if (!noteProcess.killed) noteProcess.kill();
    await Promise.allSettled([
      vite.close(),
      workerModule.close(),
    ]);
  };
}
