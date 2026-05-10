// ═══════════════════════════════════════════════════════
//  CHATROOM — Cloudflare Worker Backend
// ═══════════════════════════════════════════════════════

import { initializeApp, getApps } from 'firebase/app';
import { getDatabase, ref, set, get, push } from 'firebase/database';

// ── ALLOWED ORIGINS ───────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://tanhachat.pages.dev',
  'http://localhost',
  'http://localhost:3000',
  'http://127.0.0.1',
  'null'
];

// ── CORS — always applied, even on crashes ────────────
function getCorsHeaders(requestOrigin) {
  const origin = ALLOWED_ORIGINS.includes(requestOrigin)
    ? requestOrigin
    : 'https://tanhachat.pages.dev';
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin'
  };
}

function jsonRes(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// ── FIREBASE INIT ─────────────────────────────────────
let _db = null;
function getDB(env) {
  if (_db) return _db;
  const cfg = {
    apiKey:            env.FIREBASE_API_KEY,
    authDomain:        env.FIREBASE_AUTH_DOMAIN,
    databaseURL:       env.FIREBASE_DATABASE_URL,
    projectId:         env.FIREBASE_PROJECT_ID,
    storageBucket:     env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID,
    appId:             env.FIREBASE_APP_ID
  };
  // Validate all keys present
  const missing = Object.entries(cfg).filter(([,v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing Firebase config: ${missing.join(', ')}`);

  const app = getApps().length ? getApps()[0] : initializeApp(cfg);
  _db = getDatabase(app);
  return _db;
}

// ── JWT ───────────────────────────────────────────────
async function signToken(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = b64url(JSON.stringify(payload));
  const sig    = await hmac(`${header}.${body}`, secret);
  return `${header}.${body}.${sig}`;
}

async function verifyToken(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = await hmac(`${header}.${body}`, secret);
    if (expected !== sig) return null;
    return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}

async function hmac(data, secret) {
  const enc = new TextEncoder();
  const key  = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig  = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}

function b64url(str) {
  const b64 = typeof str === 'string'
    ? btoa(unescape(encodeURIComponent(str)))
    : btoa(str);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashPassword(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function authenticate(request, env) {
  const auth  = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  return verifyToken(token, env.JWT_SECRET);
}

// ── MAIN EXPORT ───────────────────────────────────────
export default {
  async fetch(request, env) {
    const reqOrigin = request.headers.get('Origin') || '';
    const ch = getCorsHeaders(reqOrigin);

    // Pre-flight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: ch });
    }

    try {
      return await route(request, env, ch);
    } catch (e) {
      console.error('WORKER ERROR:', e?.message, e?.stack);
      return jsonRes({ error: e?.message || 'Internal server error' }, 500, ch);
    }
  }
};

// ── ROUTER ────────────────────────────────────────────
async function route(request, env, ch) {
  const url  = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const E = (msg, status) => jsonRes({ error: msg }, status || 400, ch);
  const J = (data, status) => jsonRes(data, status || 200, ch);

  // ── POST /auth/register ────────────────────────────
  if (path === '/auth/register' && method === 'POST') {
    const { username, password } = await request.json();
    if (!username || !password)                       return E('Missing fields');
    if (username.length < 2 || username.length > 20) return E('Username 2-20 chars');
    if (password.length < 4)                          return E('Password too short');
    if (!env.JWT_SECRET)                              return E('Server misconfigured: JWT_SECRET missing', 500);

    const db      = getDB(env);
    const userRef = ref(db, `users/${username}`);
    const snap    = await get(userRef);
    if (snap.exists()) return E('Username taken', 409);

    await set(userRef, { username, hash: await hashPassword(password), createdAt: Date.now() });
    const token = await signToken({ username, iat: Date.now() }, env.JWT_SECRET);
    return J({ username, token });
  }

  // ── POST /auth/login ───────────────────────────────
  if (path === '/auth/login' && method === 'POST') {
    const { username, password } = await request.json();
    if (!username || !password) return E('Missing fields');
    if (!env.JWT_SECRET)        return E('Server misconfigured: JWT_SECRET missing', 500);

    const db   = getDB(env);
    const snap = await get(ref(db, `users/${username}`));
    if (!snap.exists()) return E('Invalid credentials', 401);

    const user = snap.val();
    if (await hashPassword(password) !== user.hash) return E('Invalid credentials', 401);

    const token = await signToken({ username, iat: Date.now() }, env.JWT_SECRET);
    return J({ username, token });
  }

  // ── AUTH WALL ──────────────────────────────────────
  const auth = await authenticate(request, env);
  if (!auth) return E('Unauthorized', 401);

  const db = getDB(env);

  // ── GET /messages ──────────────────────────────────
  if (path === '/messages' && method === 'GET') {
    const since = parseInt(url.searchParams.get('since') || '0');
    const snap  = await get(ref(db, 'messages/room1'));

    const msgs = [];
    if (snap.exists()) {
      snap.forEach(child => {
        const m = child.val();
        if (m.timestamp > since) msgs.push(m);
      });
      // sort by timestamp ascending
      msgs.sort((a, b) => a.timestamp - b.timestamp);
    }
    return J({ messages: msgs });
  }

  // ── POST /messages ─────────────────────────────────
  if (path === '/messages' && method === 'POST') {
    const { type, content, replyTo, mimeType, duration } = await request.json();
    if (!type || !content) return E('Missing type or content');
    if (content.length > 9_000_000) return E('File too large. Max ~6.5 MB.', 413);

    const storedContent = type === 'text'
      ? content
      : `data:${mimeType || 'application/octet-stream'};base64,${content}`;

    const msgRef  = push(ref(db, 'messages/room1'));
    const msgData = {
      id:        msgRef.key,
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
    await set(msgRef, msgData);
    return J(msgData);
  }

  // ── PATCH /messages/:id ────────────────────────────
  const editMatch = path.match(/^\/messages\/([^/]+)$/);
  if (editMatch && method === 'PATCH') {
    const msgRef = ref(db, `messages/room1/${editMatch[1]}`);
    const snap   = await get(msgRef);
    if (!snap.exists())                        return E('Not found', 404);
    const msg = snap.val();
    if (msg.author !== auth.username)          return E('Forbidden', 403);
    if (msg.deleted)                           return E('Message deleted');
    if (msg.type !== 'text')                   return E('Can only edit text messages');
    if (Date.now() - msg.timestamp > 900_000)  return E('Edit window expired (15 min)');
    const { content } = await request.json();
    if (!content?.trim())                      return E('Empty content');
    const updated = { ...msg, content: content.trim(), edited: true, updatedAt: Date.now() };
    await set(msgRef, updated);
    return J(updated);
  }

  // ── DELETE /messages/:id ───────────────────────────
  if (editMatch && method === 'DELETE') {
    const msgRef = ref(db, `messages/room1/${editMatch[1]}`);
    const snap   = await get(msgRef);
    if (!snap.exists()) return E('Not found', 404);
    const msg = snap.val();
    if (msg.author !== auth.username) return E('Forbidden', 403);
    const updated = { ...msg, content: '', deleted: true, updatedAt: Date.now() };
    await set(msgRef, updated);
    return J(updated);
  }

  // ── POST /messages/:id/react ───────────────────────
  const reactMatch = path.match(/^\/messages\/([^/]+)\/react$/);
  if (reactMatch && method === 'POST') {
    const msgRef = ref(db, `messages/room1/${reactMatch[1]}`);
    const snap   = await get(msgRef);
    if (!snap.exists()) return E('Not found', 404);
    const msg = snap.val();
    if (msg.deleted) return E('Message deleted');
    const { emoji } = await request.json();
    if (!emoji) return E('Missing emoji');
    const reactions = { ...(msg.reactions || {}) };
    if (reactions[auth.username] === emoji) delete reactions[auth.username];
    else reactions[auth.username] = emoji;
    const updated = { ...msg, reactions, updatedAt: Date.now() };
    await set(msgRef, updated);
    return J(updated);
  }

  // ── POST /presence ─────────────────────────────────
  if (path === '/presence' && method === 'POST') {
    await set(ref(db, `presence/${auth.username}`), { username: auth.username, lastSeen: Date.now() });
    return J({ ok: true });
  }

  // ── GET /presence ──────────────────────────────────
  if (path === '/presence' && method === 'GET') {
    const snap  = await get(ref(db, 'presence'));
    const now   = Date.now();
    const users = [];
    if (snap.exists()) {
      snap.forEach(child => {
        const p = child.val();
        if (now - p.lastSeen < 10000) users.push(p.username);
      });
    }
    return J({ users });
  }

  return E('Not found', 404);
}