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
    const keys = [...url.searchParams.keys()];
    return keys.length === 1 && keys[0] === 'path' && Boolean(url.searchParams.get('path'));
  }
  if (url.search) return false;
  if (method === 'GET' && url.pathname === '/api/canvas-projects') return true;
  if (method === 'GET' && url.pathname === '/api/canvas-projects/events') return true;
  if (method === 'POST' && url.pathname === '/api/canvas-projects/active') return true;
  if (method === 'POST' && /^\/api\/canvas-projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/live-stroke$/.test(url.pathname)) return true;
  if (method === 'POST' && url.pathname === '/api/save-note') return true;
  if (method === 'GET' && (url.pathname === '/api/learning-data' || url.pathname === '/api/learning-data/events')) return true;
  if (method === 'POST' && (url.pathname === '/api/learning-data/notes' || url.pathname === '/api/learning-data/cards')) return true;
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
