// ═══════════════════════════════════════════════════════
//  CHATROOM — Cloudflare Worker Backend
//  Uses Firebase REST API directly (no SDK, no npm deps)
// ═══════════════════════════════════════════════════════

// ── FIREBASE REST HELPERS ─────────────────────────────
function fbUrl(env, path) {
  return `${env.FIREBASE_DATABASE_URL}/${path}.json?auth=${env.FIREBASE_SECRET}`;
}

async function fbGet(env, path) {
  const r = await fetch(fbUrl(env, path));
  if (!r.ok) throw new Error(`Firebase GET ${path} → ${r.status}`);
  return r.json();
}

async function fbSet(env, path, data) {
  const r = await fetch(fbUrl(env, path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Firebase PUT ${path} → ${r.status}`);
  return r.json();
}

async function fbPush(env, path, data) {
  const r = await fetch(fbUrl(env, path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Firebase POST ${path} → ${r.status}`);
  return r.json(); // { name: "-Nxxx" }
}

// ── CORS ──────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://tanhachat.pages.dev',
  'http://localhost',
  'http://localhost:3000',
  'http://127.0.0.1',
  'null'
];

function corsHeaders(reqOrigin) {
  const origin = ALLOWED_ORIGINS.includes(reqOrigin)
    ? reqOrigin
    : 'https://tanhachat.pages.dev';
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age':       '86400',
    'Vary': 'Origin'
  };
}

function J(data, status, ch) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...ch }
  });
}

// ── JWT (pure Web Crypto, zero deps) ─────────────────
async function signToken(payload, secret) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const b = b64u(JSON.stringify(payload));
  const s = await hs256(`${h}.${b}`, secret);
  return `${h}.${b}.${s}`;
}

async function verifyToken(token, secret) {
  try {
    const [h, b, s] = token.split('.');
    if (await hs256(`${h}.${b}`, secret) !== s) return null;
    return JSON.parse(atob(b.replace(/-/g,'+').replace(/_/g,'/')));
  } catch { return null; }
}

async function hs256(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64u(String.fromCharCode(...new Uint8Array(sig)));
}

function b64u(s) {
  return btoa(typeof s === 'string' ? unescape(encodeURIComponent(s)) : s)
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function hashPw(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
}

async function authn(request, env) {
  const h = request.headers.get('Authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return null;
  return verifyToken(t, env.JWT_SECRET);
}

// ── MAIN ──────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const ch = corsHeaders(origin);

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: ch });

    try {
      return await route(request, env, ch);
    } catch (e) {
      console.error('CRASH:', e.message);
      return J({ error: e.message || 'Internal error' }, 500, ch);
    }
  }
};

async function route(request, env, ch) {
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;
  const E = (msg, s) => J({ error: msg }, s || 400, ch);

  // ── POST /auth/register ──────────────────────────────
  if (path === '/auth/register' && method === 'POST') {
    const { username, password } = await request.json();
    if (!username || !password)                       return E('Missing fields');
    if (username.length < 2 || username.length > 20) return E('Username 2-20 chars');
    if (password.length < 4)                          return E('Password too short');

    const existing = await fbGet(env, `users/${username}`);
    if (existing) return E('Username taken', 409);

    await fbSet(env, `users/${username}`, {
      username,
      hash: await hashPw(password),
      createdAt: Date.now()
    });
    const token = await signToken({ username, iat: Date.now() }, env.JWT_SECRET);
    return J({ username, token }, 200, ch);
  }

  // ── POST /auth/login ─────────────────────────────────
  if (path === '/auth/login' && method === 'POST') {
    const { username, password } = await request.json();
    if (!username || !password) return E('Missing fields');

    const user = await fbGet(env, `users/${username}`);
    if (!user) return E('Invalid credentials', 401);
    if (await hashPw(password) !== user.hash) return E('Invalid credentials', 401);

    const token = await signToken({ username, iat: Date.now() }, env.JWT_SECRET);
    return J({ username, token }, 200, ch);
  }

  // ── AUTH WALL ────────────────────────────────────────
  const auth = await authn(request, env);
  if (!auth) return E('Unauthorized', 401);

  // ── GET /messages ────────────────────────────────────
  if (path === '/messages' && method === 'GET') {
    const since = parseInt(url.searchParams.get('since') || '0');
    const data  = await fbGet(env, 'messages/room1');

    const msgs = [];
    if (data) {
      for (const key of Object.keys(data)) {
        const m = data[key];
        if (since === 0 || m.timestamp > since) msgs.push(m);
      }
      msgs.sort((a, b) => a.timestamp - b.timestamp);
    }
    return J({ messages: msgs }, 200, ch);
  }

  // ── POST /messages ───────────────────────────────────
  if (path === '/messages' && method === 'POST') {
    const { type, content, replyTo, mimeType, duration } = await request.json();
    if (!type || !content) return E('Missing type or content');
    if (content.length > 9_000_000) return E('File too large. Max ~6.5 MB.', 413);

    const storedContent = type === 'text'
      ? content
      : `data:${mimeType || 'application/octet-stream'};base64,${content}`;

    const pushed = await fbPush(env, 'messages/room1', {});
    const id = pushed.name;
    const msgData = {
      id,
      author:    auth.username,
      type,
      content:   storedContent,
      duration:  duration || null,
      replyTo:   replyTo  || null,
      reactions: {},
      timestamp: Date.now(),
      updatedAt: Date.now(),
      edited:    false,
      deleted:   false
    };
    await fbSet(env, `messages/room1/${id}`, msgData);
    return J(msgData, 200, ch);
  }

  // ── PATCH /messages/:id ──────────────────────────────
  const editMatch = path.match(/^\/messages\/([^/]+)$/);
  if (editMatch && method === 'PATCH') {
    const id  = editMatch[1];
    const msg = await fbGet(env, `messages/room1/${id}`);
    if (!msg)                                    return E('Not found', 404);
    if (msg.author !== auth.username)            return E('Forbidden', 403);
    if (msg.deleted)                             return E('Message deleted');
    if (msg.type !== 'text')                     return E('Can only edit text');
    if (Date.now() - msg.timestamp > 900_000)    return E('Edit window expired');
    const { content } = await request.json();
    if (!content?.trim())                        return E('Empty content');
    const updated = { ...msg, content: content.trim(), edited: true, updatedAt: Date.now() };
    await fbSet(env, `messages/room1/${id}`, updated);
    return J(updated, 200, ch);
  }

  // ── DELETE /messages/:id ─────────────────────────────
  if (editMatch && method === 'DELETE') {
    const id  = editMatch[1];
    const msg = await fbGet(env, `messages/room1/${id}`);
    if (!msg)                         return E('Not found', 404);
    if (msg.author !== auth.username) return E('Forbidden', 403);
    const updated = { ...msg, content: '', deleted: true, updatedAt: Date.now() };
    await fbSet(env, `messages/room1/${id}`, updated);
    return J(updated, 200, ch);
  }

  // ── POST /messages/:id/react ─────────────────────────
  const reactMatch = path.match(/^\/messages\/([^/]+)\/react$/);
  if (reactMatch && method === 'POST') {
    const id  = reactMatch[1];
    const msg = await fbGet(env, `messages/room1/${id}`);
    if (!msg)        return E('Not found', 404);
    if (msg.deleted) return E('Message deleted');
    const { emoji } = await request.json();
    if (!emoji)      return E('Missing emoji');
    const reactions = { ...(msg.reactions || {}) };
    if (reactions[auth.username] === emoji) delete reactions[auth.username];
    else reactions[auth.username] = emoji;
    const updated = { ...msg, reactions, updatedAt: Date.now() };
    await fbSet(env, `messages/room1/${id}`, updated);
    return J(updated, 200, ch);
  }

  // ── POST /presence ───────────────────────────────────
  if (path === '/presence' && method === 'POST') {
    await fbSet(env, `presence/${auth.username}`, {
      username: auth.username,
      lastSeen: Date.now()
    });
    return J({ ok: true }, 200, ch);
  }

  // ── GET /presence ────────────────────────────────────
  if (path === '/presence' && method === 'GET') {
    const data  = await fbGet(env, 'presence');
    const now   = Date.now();
    const users = [];
    if (data) {
      for (const u of Object.values(data)) {
        if (now - u.lastSeen < 10000) users.push(u.username);
      }
    }
    return J({ users }, 200, ch);
  }

  return E('Not found', 404);
}