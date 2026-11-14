/**
 * ============================================================================
 * AGENT AUTH (renderer/js/agent-auth.js)
 * ============================================================================
 * The local agent requires x-artemis-token on every /api request. CORS alone
 * cannot tell this file:// page apart from a sandboxed iframe, so the token
 * is the boundary. Patch fetch once, before any client module runs, instead
 * of repeating the header in every caller.
 *
 * Only loopback /api URLs receive the token; nothing else should ever see it.
 * ============================================================================
 */
(() => {
  const token = globalThis.appConfig?.apiToken;
  if (typeof token !== 'string' || !token) return;

  const originalFetch = globalThis.fetch.bind(globalThis);

  const isAgentRequest = (rawUrl) => {
    try {
      const url = new URL(rawUrl, globalThis.location.href);
      const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
      return loopback && url.pathname.startsWith('/api');
    } catch {
      return false;
    }
  };

  globalThis.fetch = (input, init) => {
    const options = init || {};
    const rawUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input?.url;

    if (!rawUrl || !isAgentRequest(rawUrl)) {
      return originalFetch(input, options);
    }

    const headers = new Headers(
      options.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
    );
    headers.set('x-artemis-token', token);
    return originalFetch(input, { ...options, headers });
  };
})();
