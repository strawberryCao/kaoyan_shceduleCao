import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { KeyRound, LoaderCircle, LogIn, ShieldCheck } from 'lucide-react';

interface CloudAuthGateProps {
  children: ReactNode;
}

interface AuthStatus {
  ok: boolean;
  authenticated: boolean;
  username?: string;
  access?: 'tailscale-primary' | 'cloudflare-fallback';
  error?: string;
}

const isLoopback = (hostname: string): boolean => (
  hostname === 'localhost'
  || hostname === '127.0.0.1'
  || hostname === '::1'
  || hostname === '[::1]'
);

const isCloudRuntime = (): boolean => (
  typeof window !== 'undefined'
  && window.location.protocol === 'https:'
  && !isLoopback(window.location.hostname.toLowerCase())
);

async function authRequest(path: string, init?: RequestInit): Promise<AuthStatus> {
  const response = await fetch(`/api/auth/${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null) as AuthStatus | null;
  if (!payload) throw new Error(`登录服务返回 ${response.status}`);
  if (!response.ok && response.status !== 401) throw new Error(payload.error || `登录服务返回 ${response.status}`);
  return payload;
}

export function CloudAuthGate({ children }: CloudAuthGateProps) {
  const cloud = isCloudRuntime();
  const [checking, setChecking] = useState(cloud);
  const [authenticated, setAuthenticated] = useState(!cloud);
  const [username, setUsername] = useState('caobiji');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [access, setAccess] = useState<AuthStatus['access']>();

  useEffect(() => {
    if (!cloud) return;
    const controller = new AbortController();
    void authRequest('status', { signal: controller.signal })
      .then((status) => {
        setAuthenticated(status.authenticated);
        if (status.username) setUsername(status.username);
        setAccess(status.access);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法检查登录状态');
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [cloud]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    try {
      setSubmitting(true);
      setError('');
      const status = await authRequest('login', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!status.authenticated) throw new Error(status.error || '登录失败');
      setPassword('');
      setAccess(status.access);
      setAuthenticated(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  if (!cloud || authenticated) return <>{children}</>;

  return (
    <main className="cloud-auth-gate">
      <form className="cloud-auth-card" onSubmit={submit}>
        <span className="cloud-auth-icon"><KeyRound size={28} /></span>
        <div>
          <h1>进入考研学习中心</h1>
          <p>笔记和图片直接保存在你的 Mac mini，请先登录后继续。</p>
        </div>
        {access && (
          <span className={`cloud-auth-access ${access === 'cloudflare-fallback' ? 'is-fallback' : ''}`}>
            <ShieldCheck size={15} />
            {access === 'cloudflare-fallback' ? 'Cloudflare 备用入口' : 'Tailscale 私有直连'}
          </span>
        )}
        {checking ? (
          <p className="cloud-auth-checking"><LoaderCircle size={18} />正在检查登录状态…</p>
        ) : (
          <>
            <label>
              <span>用户名</span>
              <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label>
              <span>密码</span>
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoFocus
              />
            </label>
            {error && <p className="cloud-auth-error" role="alert">{error}</p>}
            <button className="primary" type="submit" disabled={submitting || !username.trim() || !password}>
              {submitting ? <LoaderCircle size={18} /> : <LogIn size={18} />}
              {submitting ? '正在登录…' : '登录'}
            </button>
          </>
        )}
      </form>
    </main>
  );
}
