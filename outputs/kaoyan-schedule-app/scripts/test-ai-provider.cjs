const dns = require('node:dns').promises;
const https = require('node:https');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadAiProviderConfigs } = require('./ai-router.cjs');

const DEFAULT_TIMEOUT_MS = 15_000;

function argumentValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : '';
}

function hasArgument(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function maskKey(value) {
  const key = String(value || '');
  if (!key) return '(未配置)';
  return `${key.slice(0, 4)}...${key.slice(-4)} (长度 ${key.length})`;
}

function errorChain(error) {
  const values = [];
  let current = error;
  while (current && values.length < 5) {
    const code = current.code ? `[${current.code}] ` : '';
    const message = current.message || String(current);
    values.push(`${code}${message}`);
    current = current.cause;
  }
  return values.join(' <- ');
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function resolveHost(hostname, timeoutMs) {
  const resolve = async (family) => {
    try {
      const values = await withTimeout(
        family === 4 ? dns.resolve4(hostname) : dns.resolve6(hostname),
        timeoutMs,
        `IPv${family} DNS`,
      );
      return { ok: true, values };
    } catch (error) {
      return { ok: false, error: errorChain(error) };
    }
  };
  const [ipv4, ipv6] = await Promise.all([resolve(4), resolve(6)]);
  return { ipv4, ipv6 };
}

function tlsProbe(urlString, family, timeoutMs) {
  return new Promise((resolve) => {
    const url = new URL(urlString);
    const startedAt = Date.now();
    const request = https.request({
      method: 'HEAD',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      family,
      timeout: timeoutMs,
      headers: { 'User-Agent': 'kaoyan-ai-diagnostic/1.0' },
    }, (response) => {
      response.resume();
      resolve({ ok: true, status: response.statusCode, elapsedMs: Date.now() - startedAt });
    });
    request.once('timeout', () => request.destroy(new Error(`TLS IPv${family} 超时`)));
    request.once('error', (error) => resolve({
      ok: false,
      error: errorChain(error),
      elapsedMs: Date.now() - startedAt,
    }));
    request.end();
  });
}

function safeResponseSummary(rawText) {
  const text = String(rawText || '');
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      return {
        array: data.slice(0, 3).map((item) => ({
          code: item?.error?.code ?? item?.code ?? null,
          status: item?.error?.status ?? item?.status ?? null,
          message: String(item?.error?.message || item?.message || '').slice(0, 500),
        })),
      };
    }
    if (data?.error) {
      return {
        error: {
          code: data.error.code ?? null,
          status: data.error.status ?? data.error.type ?? null,
          message: String(data.error.message || '').slice(0, 500),
        },
      };
    }
    const content = String(data?.choices?.[0]?.message?.content || '').slice(0, 200);
    if (content || data?.model || data?.usage) {
      return { content, model: data?.model || null, usage: data?.usage || null };
    }
    return {
      keys: Object.keys(data || {}).slice(0, 20),
      code: data?.code ?? null,
      status: data?.status ?? null,
      message: String(data?.message || data?.detail || data?.msg || '').slice(0, 500),
    };
  } catch {
    return { text: text.slice(0, 500) };
  }
}

function buildPayload(provider) {
  const model = provider.models[0]?.id || '';
  const isKimiThinkingModel = provider.id === 'kimi' && /^kimi-k(?:3|2\.(?:5|6|7))/i.test(model);
  const payload = {
    model,
    messages: [{ role: 'user', content: '只回复 OK' }],
    stream: false,
  };
  if (isKimiThinkingModel) {
    payload.max_completion_tokens = 16;
    if (/^kimi-k3(?:$|-)/i.test(model)) payload.reasoning_effort = 'low';
  } else {
    payload.max_tokens = 16;
    payload.temperature = 0;
  }
  return payload;
}

async function apiProbe(provider, timeoutMs) {
  const startedAt = Date.now();
  try {
    const response = await fetch(provider.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        ...provider.headers,
      },
      body: JSON.stringify(buildPayload(provider)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const rawText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      response: safeResponseSummary(rawText),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      elapsedMs: Date.now() - startedAt,
      error: errorChain(error),
    };
  }
}

function diagnosis(result) {
  if (result.ok) return '接口、密钥和模型均可用。';
  const responseText = JSON.stringify(result.response || {}).toLowerCase();
  if (responseText.includes('valid api key') || responseText.includes('incorrect api key')) {
    return '网络已经到达接口，但当前 API Key 无效、过期或不是该官方开放平台签发的 Key。';
  }
  if (result.status === 400) return '网络已经到达接口；请求参数或模型名称不被接受，请看上面的服务端错误。';
  if (result.status === 401) return '网络已经到达接口，但 API Key 无效、过期或不属于该平台。';
  if (result.status === 403) return '网络已经到达接口，但账号权限、地区策略、项目权限或代理出口地区被拒绝。';
  if (result.status === 404) return '网络已经到达接口，但接口地址或模型名称很可能不存在。';
  if (result.status === 429) return '网络已经到达接口，但额度、余额或请求频率受限。';
  if (result.status && result.status >= 500) return '网络已经到达接口，服务端或代理上游暂时异常。';
  return '请求没有拿到 HTTP 响应，属于 DNS、TCP/TLS、代理分流或连接重置问题。';
}

function printResult(label, result) {
  console.log(`\n[${label}]`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`结论：${diagnosis(result)}`);
}

function runProxyChild(providerId, proxyUrl, timeoutMs) {
  const supportsEnvProxy = process.allowedNodeEnvironmentFlags.has('--use-env-proxy');
  if (!supportsEnvProxy) {
    console.log('\n[显式代理测试] 当前 Node 不支持 --use-env-proxy，无法安全执行代理对照测试。');
    return 1;
  }
  const args = [
    '--use-env-proxy',
    path.resolve(process.argv[1]),
    '--internal-proxy-child',
    `--timeout=${timeoutMs}`,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NODE_USE_ENV_PROXY: '1',
      KAOYAN_AI_PROVIDER: providerId,
    },
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`代理子进程启动失败：${errorChain(result.error)}`);
    return 1;
  }
  return result.status ?? 1;
}

async function runProviderTest(providerId) {
  const timeoutMs = Math.max(2_000, Math.min(60_000, Number(argumentValue('timeout')) || DEFAULT_TIMEOUT_MS));
  const config = loadAiProviderConfigs();
  const provider = config.providers.find((item) => item.id === providerId);
  const internalProxyChild = hasArgument('internal-proxy-child');
  const explicitProxy = argumentValue('proxy');
  const environmentProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '';

  console.log(`---- ${providerId.toUpperCase()} API 诊断 ----`);
  console.log(`Node=${process.version}`);
  console.log(`configPath=${config.configPath}`);
  console.log(`运行模式=${internalProxyChild ? '显式代理' : '当前应用默认网络路径'}`);
  console.log(`HTTP(S)_PROXY=${environmentProxy || '(未设置；Node 默认不会继承浏览器代理)'}`);

  if (!provider) {
    console.error(`FAIL: ${providerId} 未配置完整的 API Key、模型或接口地址。`);
    process.exitCode = 1;
    return;
  }

  const target = new URL(provider.baseUrl);
  console.log(`apiKey=${maskKey(provider.apiKey)}`);
  console.log(`model=${provider.models[0]?.id || '(未配置)'}`);
  console.log(`baseUrl=${provider.baseUrl}`);

  if (!internalProxyChild) {
    const dnsResult = await resolveHost(target.hostname, Math.min(timeoutMs, 5_000));
    console.log('\n[DNS]');
    console.log(JSON.stringify(dnsResult, null, 2));

    const [ipv4Tls, ipv6Tls] = await Promise.all([
      tlsProbe(provider.baseUrl, 4, Math.min(timeoutMs, 8_000)),
      tlsProbe(provider.baseUrl, 6, Math.min(timeoutMs, 8_000)),
    ]);
    console.log('\n[TCP/TLS 对照；HTTP 404/405 也代表网络已连通]');
    console.log(JSON.stringify({ ipv4: ipv4Tls, ipv6: ipv6Tls }, null, 2));
  }

  const result = await apiProbe(provider, timeoutMs);
  printResult(internalProxyChild ? '通过指定代理的最小 API 请求' : '应用默认路径的最小 API 请求', result);

  if (internalProxyChild) {
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const proxyUrl = explicitProxy || environmentProxy;
  if (proxyUrl) {
    console.log(`\n即将使用显式代理做对照：${proxyUrl.replace(/:\/\/[^@/]+@/, '://***@')}`);
    const status = runProxyChild(providerId, proxyUrl, timeoutMs);
    if (status !== 0) process.exitCode = 1;
  } else {
    console.log('\n[代理对照未运行]');
    console.log('浏览器能访问 YouTube 只说明浏览器代理链路可用。若要测试同一个代理，请追加：');
    console.log(`node "${path.relative(process.cwd(), process.argv[1])}" --proxy=http://127.0.0.1:你的HTTP代理端口`);
  }

  if (!result.ok) process.exitCode = 1;
}

module.exports = { runProviderTest };
