// ═══════════════════════════════════════════════════════
//  CHATROOM — Cloudflare Worker Backend
//  Media stored as base64 data-URI directly in Firebase.
//  Routes:
//    POST   /auth/register
//    POST   /auth/login
//    GET    /messages?since=<timestamp>
//    POST   /messages
//    PATCH  /messages/:id
//    DELETE /messages/:id
//    POST   /messages/:id/react
//    POST   /presence
//    GET    /presence
// ═══════════════════════════════════════════════════════

import { initializeApp, getApps } from 'firebase/app';
import { getDatabase, ref, set, get, push, query, orderByChild, startAt } from 'firebase/database';

// ── FIREBASE INIT (lazy singleton) ──────────────────────
let _db = null;
function getDB(env) {
  if (_db) return _db;
  const app = getApps().length ? getApps()[0] : initializeApp({
    apiKey:            env.FIREBASE_API_KEY,
    authDomain:        env.FIREBASE_AUTH_DOMAIN,
    databaseURL:       env.FIREBASE_DATABASE_URL,
    projectId:         env.FIREBASE_PROJECT_ID,
    storageBucket:     env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID,
    appId:             env.FIREBASE_APP_ID
  });
  _db = getDatabase(app);
  return _db;
}

// ── JWT-LITE (Web Crypto, no deps) ───────────────────────
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
  let b64;
  if (typeof str === 'string' && str.split('').every(c => c.charCodeAt(0) < 256)) {
    b64 = btoa(unescape(encodeURIComponent(str)));
  } else {
    b64 = btoa(str);
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── PASSWORD HASH (SHA-256) ───────────────────────────────
async function hashPassword(password) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── CORS ─────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://tanhachat.pages.dev',
  'http://localhost',
  'http://127.0.0.1',
  'null' // file:// opens as origin "null"
];

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age':       '86400'
  };
}

function json(data, status = 200, corsOrigin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(corsOrigin) }
  });
}

function err(msg, status = 400) { return json({ error: msg }, status); }

// ── AUTH MIDDLEWARE ───────────────────────────────────────
async function authenticate(request, env) {
  const auth  = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  return verifyToken(token, env.JWT_SECRET);
}

// ── MAIN HANDLER ─────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    const url  = new URL(request.url);
    const path = url.pathname;
    const db   = getDB(env);

    // ── POST /auth/register ──────────────────────────────
    if (path === '/auth/register' && request.method === 'POST') {
      const { username, password } = await request.json();
      if (!username || !password)                       return err('Missing fields');
      if (username.length < 2 || username.length > 20) return err('Username 2-20 chars');
      if (password.length < 4)                          return err('Password too short');

      const userRef = ref(db, `users/${username}`);
      const snap    = await get(userRef);
      if (snap.exists()) return err('Username taken', 409);

      await set(userRef, { username, hash: await hashPassword(password), createdAt: Date.now() });
      const token = await signToken({ username, iat: Date.now() }, env.JWT_SECRET);
      return json({ username, token });
    }

    // ── POST /auth/login ─────────────────────────────────
    if (path === '/auth/login' && request.method === 'POST') {
      const { username, password } = await request.json();
      if (!username || !password) return err('Missing fields');

      const snap = await get(ref(db, `users/${username}`));
      if (!snap.exists()) return err('Invalid credentials', 401);

      const user = snap.val();
      if (await hashPassword(password) !== user.hash) return err('Invalid credentials', 401);

      const token = await signToken({ username, iat: Date.now() }, env.JWT_SECRET);
      return json({ username, token });
    }

    // ── Auth required below ───────────────────────────────
    const auth = await authenticate(request, env);
    if (!auth) return err('Unauthorized', 401);

    // ── GET /messages ────────────────────────────────────
    if (path === '/messages' && request.method === 'GET') {
      const since   = parseInt(url.searchParams.get('since') || '0');
      const msgsRef = query(ref(db, 'messages/room1'), orderByChild('timestamp'), startAt(since || 0));
      const snap    = await get(msgsRef);

      const msgs = [];
      if (snap.exists()) {
        snap.forEach(child => {
          const m = child.val();
          if (m.timestamp > since) msgs.push(m);
        });
      }
      return json({ messages: msgs });
    }

    // ── POST /messages ───────────────────────────────────
    if (path === '/messages' && request.method === 'POST') {
      const { type, content, replyTo, mimeType, duration } = await request.json();
      if (!type || !content) return err('Missing type or content');

      // Firebase Realtime DB node limit is 10 MB.
      // base64 overhead is ~33%, so cap raw base64 string at ~9 MB.
      if (content.length > 9_000_000) return err('File too large. Max ~6.5 MB.', 413);

      // For images/voice: store a proper data-URI so the frontend can use it directly as src/href.
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
      return json(msgData);
    }

    // ── PATCH /messages/:id  (edit text, 15-min window) ──
    const editMatch = path.match(/^\/messages\/([^/]+)$/);
    if (editMatch && request.method === 'PATCH') {
      const msgRef = ref(db, `messages/room1/${editMatch[1]}`);
      const snap   = await get(msgRef);
      if (!snap.exists())                       return err('Not found', 404);

      const msg = snap.val();
      if (msg.author !== auth.username)         return err('Forbidden', 403);
      if (msg.deleted)                          return err('Message deleted');
      if (msg.type !== 'text')                  return err('Can only edit text messages');
      if (Date.now() - msg.timestamp > 900_000) return err('Edit window expired (15 min)');

      const { content } = await request.json();
      if (!content?.trim()) return err('Empty content');

      const updated = { ...msg, content: content.trim(), edited: true, updatedAt: Date.now() };
      await set(msgRef, updated);
      return json(updated);
    }

    // ── DELETE /messages/:id ─────────────────────────────
    if (editMatch && request.method === 'DELETE') {
      const msgRef = ref(db, `messages/room1/${editMatch[1]}`);
      const snap   = await get(msgRef);
      if (!snap.exists()) return err('Not found', 404);

      const msg = snap.val();
      if (msg.author !== auth.username) return err('Forbidden', 403);

      // Clear content on delete to reclaim Firebase storage
      const updated = { ...msg, content: '', deleted: true, updatedAt: Date.now() };
      await set(msgRef, updated);
      return json(updated);
    }

    // ── POST /messages/:id/react ─────────────────────────
    const reactMatch = path.match(/^\/messages\/([^/]+)\/react$/);
    if (reactMatch && request.method === 'POST') {
      const msgRef = ref(db, `messages/room1/${reactMatch[1]}`);
      const snap   = await get(msgRef);
      if (!snap.exists()) return err('Not found', 404);

      const msg = snap.val();
      if (msg.deleted) return err('Message deleted');

      const { emoji } = await request.json();
      if (!emoji) return err('Missing emoji');

      const reactions = { ...(msg.reactions || {}) };
      // Toggle: same emoji → remove; different/none → set
      if (reactions[auth.username] === emoji) {
        delete reactions[auth.username];
      } else {
        reactions[auth.username] = emoji;
      }

      const updated = { ...msg, reactions, updatedAt: Date.now() };
      await set(msgRef, updated);
      return json(updated);
    }

    // ── POST /presence  (heartbeat ping) ─────────────────
    if (path === '/presence' && request.method === 'POST') {
      await set(ref(db, `presence/${auth.username}`), { username: auth.username, lastSeen: Date.now() });
      return json({ ok: true });
    }

    // ── GET /presence  (online user list) ────────────────
    if (path === '/presence' && request.method === 'GET') {
      const snap  = await get(ref(db, 'presence'));
      const now   = Date.now();
      const users = [];
      if (snap.exists()) {
        snap.forEach(child => {
          const p = child.val();
          if (now - p.lastSeen < 10000) users.push(p.username);
        });
      }
      return json({ users });
    }

    return err('Not found', 404);
  }
};