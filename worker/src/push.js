// Web Push sender (VAPID, RFC 8292) with empty payloads: no aes128gcm encryption needed, which keeps CPU low.
// The service worker reacts to the push by fetching /api/snapshot.json and showing the newest alert.
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));

async function vapidJWT(aud, env) {
  const header = b64u(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://nba-matchup.nbalab.workers.dev' })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64u(sig)}`;
}

export async function sendPush(env) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC) return { sent: 0, reason: 'VAPID not configured' };
  const snap = await env.SNAP.get('latest', 'json'); if (!snap) return { sent: 0 };
  const sentIds = new Set((await env.SNAP.get('pushed', 'json')) || []);
  const fresh = (snap.alerts || []).filter(a => a.severity === 'crit' && !sentIds.has(a.id));
  if (!fresh.length) return { sent: 0 };
  const list = await env.SNAP.list({ prefix: 'sub:' }); let sent = 0;
  for (const k of list.keys) {
    const sub = await env.SNAP.get(k.name, 'json'); if (!sub) continue;
    const aud = new URL(sub.endpoint).origin;
    const r = await fetch(sub.endpoint, { method: 'POST', headers: { TTL: '3600', Urgency: 'high', Authorization: `vapid t=${await vapidJWT(aud, env)}, k=${env.VAPID_PUBLIC}` } });
    if (r.status === 404 || r.status === 410) await env.SNAP.delete(k.name); else if (r.ok) sent++;
  }
  for (const a of fresh) sentIds.add(a.id);
  await env.SNAP.put('pushed', JSON.stringify([...sentIds].slice(-500)), { expirationTtl: 3 * 86400 });
  return { sent };
}
export { fromB64u };
