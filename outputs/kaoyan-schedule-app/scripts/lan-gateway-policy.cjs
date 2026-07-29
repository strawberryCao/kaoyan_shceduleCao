const createAllowedHosts = (networkInterfaces = {}) => {
  const hosts = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  for (const entries of Object.values(networkInterfaces)) {
    for (const entry of entries || []) {
      if (entry?.family === 'IPv4' && !entry.internal) {
        hosts.add(entry.address.toLowerCase());
      }
    }
  }
  return hosts;
};

const hostnameFromHostHeader = (hostHeader = '') => {
  const normalized = String(hostHeader).trim().toLowerCase();
  if (normalized.startsWith('[')) {
    const closingBracket = normalized.indexOf(']');
    return closingBracket >= 0 ? normalized.slice(1, closingBracket) : '';
  }
  return normalized.split(':')[0];
};

const isAllowedLanApiRoute = (method, requestUrl) => {
  const url = new URL(requestUrl || '/', 'http://127.0.0.1:5173');
  if (method === 'GET' && url.pathname === '/api/note-file') {
    const allowedKeys = new Set(['path', 'preview']);
    const keys = [...url.searchParams.keys()];
    return keys.every((key) => allowedKeys.has(key))
      && Boolean(url.searchParams.get('path'))
      && (url.searchParams.get('preview') === null || url.searchParams.get('preview') === '1');
  }
  if (url.search) return false;
  if (method === 'GET' && url.pathname === '/api/canvas-projects') return true;
  if (method === 'GET' && url.pathname === '/api/canvas-projects/events') return true;
  if (method === 'POST' && url.pathname === '/api/canvas-projects/active') return true;
  if (method === 'POST' && /^\/api\/canvas-projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/live-stroke$/.test(url.pathname)) return true;
  if ((method === 'GET' || method === 'POST') && /^\/api\/canvas-projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/ai-organize$/.test(url.pathname)) return true;
  if (method === 'POST' && ['/api/save-note', '/api/save-note-batch', '/api/save-material-note', '/api/append-material-note', '/api/capture-batches'].includes(url.pathname)) return true;
  if (method === 'GET' && /^\/api\/jobs\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(url.pathname)) return true;
  if (method === 'POST' && /^\/api\/jobs\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/retry$/.test(url.pathname)) return true;
  if (method === 'GET' && (url.pathname === '/api/learning-data' || url.pathname === '/api/learning-data/events')) return true;
  if (method === 'GET' && /^\/api\/ai\/jobs\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(url.pathname)) return true;
  if (method === 'POST' && url.pathname === '/api/search') return true;
  if (method === 'POST' && (url.pathname === '/api/learning-data/notes' || url.pathname === '/api/learning-data/cards')) return true;
  if (method === 'POST' && /^\/api\/learning-data\/notes\/[^/]+\/rename$/.test(url.pathname)) return true;
  if (method === 'POST' && url.pathname === '/api/learning-data/note-review-actions') return true;
  if (method === 'PATCH' && url.pathname === '/api/learning-data/day') return true;
  if (method === 'PUT' && url.pathname === '/api/learning-data/manual-records') return true;
  if (method === 'POST' && /^\/api\/learning-data\/notes\/[^/]+\/restore$/.test(url.pathname)) return true;
  if ((method === 'PATCH' || method === 'DELETE') && /^\/api\/learning-data\/(?:notes|cards)\/[^/]+$/.test(url.pathname)) return true;
  return (method === 'GET' || method === 'PUT' || method === 'DELETE')
    && /^\/api\/canvas-projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(url.pathname);
};

module.exports = {
  createAllowedHosts,
  hostnameFromHostHeader,
  isAllowedLanApiRoute,
};
