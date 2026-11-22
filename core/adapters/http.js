// Shared HTTP helper for every adapter. Plain ES module, zero deps, no node: imports.
// Contract: resolves to { ok, status, bytes, ms, host, url, data, error, headers } and NEVER throws.

export const UA_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

// Full Chrome 140 client hints. cdn.nba.com / stats.nba.com reject requests without these.
export const CHROME_HEADERS = Object.freeze({
  'User-Agent': UA_CHROME,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  Origin: 'https://www.nba.com',
  Referer: 'https://www.nba.com/',
  'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  Connection: 'keep-alive',
});

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function headerMap(res) {
  const out = {};
  try {
    if (res && res.headers && typeof res.headers.forEach === 'function') {
      res.headers.forEach((v, k) => {
        out[String(k).toLowerCase()] = v;
      });
    } else if (res && res.headers && typeof res.headers === 'object') {
      for (const [k, v] of Object.entries(res.headers)) out[k.toLowerCase()] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/**
 * GET a URL and parse JSON (or return text when text=true, or ArrayBuffer when binary=true).
 * @returns {Promise<{ok:boolean,status:number,bytes:number,ms:number,host:string,url:string,data:any,error:string|null,headers:object}>}
 */
export async function getJSON(fetchImpl, url, { headers, timeoutMs = 8000, text = false, binary = false } = {}) {
  const t0 = now();
  const host = hostOf(url);
  const base = { ok: false, status: 0, bytes: 0, ms: 0, host, url, data: null, error: null, headers: {} };
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return { ...base, error: 'no fetch implementation' };
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        ac && ac.abort();
      } catch {
        /* ignore */
      }
      resolve({ __timeout: true });
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([f(url, { method: 'GET', headers: headers || {}, signal: ac ? ac.signal : undefined }), timeout]);
    if (res && res.__timeout) return { ...base, ms: Math.round(now() - t0), error: `timeout after ${timeoutMs}ms` };
    const status = res.status ?? 0;
    const hdrs = headerMap(res);
    let body;
    let bytes = 0;
    if (binary) {
      const buf = await Promise.race([res.arrayBuffer(), timeout]);
      if (buf && buf.__timeout) return { ...base, status, headers: hdrs, ms: Math.round(now() - t0), error: `timeout after ${timeoutMs}ms` };
      body = buf;
      bytes = buf ? buf.byteLength : 0;
    } else {
      const raw = await Promise.race([res.text(), timeout]);
      if (raw && raw.__timeout) return { ...base, status, headers: hdrs, ms: Math.round(now() - t0), error: `timeout after ${timeoutMs}ms` };
      bytes = raw ? raw.length : 0;
      if (text) body = raw;
      else {
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch (e) {
          const ok = false;
          const httpOk = status >= 200 && status < 300;
          return { ...base, ok, status, bytes, headers: hdrs, ms: Math.round(now() - t0), data: null, error: httpOk ? `invalid JSON: ${String(e.message || e).slice(0, 120)}` : `HTTP ${status}` };
        }
      }
    }
    const ok = status >= 200 && status < 300;
    return { ...base, ok, status, bytes, headers: hdrs, ms: Math.round(now() - t0), data: body, error: ok ? null : `HTTP ${status}` };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String((e && e.message) || e);
    return { ...base, ms: Math.round(now() - t0), error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Wrap a getJSON result with a transform; transform errors become ok:false. Never throws. */
export function mapResult(r, fn) {
  if (!r.ok) return r;
  try {
    return { ...r, data: fn(r.data) };
  } catch (e) {
    return { ...r, ok: false, data: null, error: `parse: ${String((e && e.message) || e)}` };
  }
}
