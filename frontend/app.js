// ═══════════════════════════════════════════════════════
//  TANHACHAT — Frontend App Logic
// ═══════════════════════════════════════════════════════

const API = CONFIG.WORKER_URL;

// ── STATE ────────────────────────────────────────────────
let currentUser  = null;   // { username, token }
let messages     = {};     // msgId → msgObj  (room)
let dmMessages   = {};     // msgId → msgObj  (current DM thread)
let replyTarget  = null;
let editTarget   = null;
let ctxTarget    = null;
let pollTimer    = null;
let dmPollTimer  = null;
let lastTs       = 0;
let dmLastTs     = 0;
let mediaRecorder  = null;
let audioChunks    = [];
let recordingStart = 0;

// Current view: 'room' | 'dm'
let currentView   = 'room';
let currentDmUser = null;   // username of DM partner

// ── DOM REFS ─────────────────────────────────────────────
const loginScreen   = document.getElementById('login-screen');
const chatScreen    = document.getElementById('chat-screen');
const loginForm     = document.getElementById('login-form');
const registerBtn   = document.getElementById('register-btn');
const loginError    = document.getElementById('login-error');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const logoutBtn     = document.getElementById('logout-btn');

const messagesArea  = document.getElementById('messages-area');
const msgInput      = document.getElementById('msg-input');
const sendBtn       = document.getElementById('send-btn');
const imgInput      = document.getElementById('img-input');
const voiceBtn      = document.getElementById('voice-btn');
const voiceIndicator= document.getElementById('voice-indicator');

const replyBar      = document.getElementById('reply-bar');
const replyPreview  = document.getElementById('reply-preview-text');
const cancelReply   = document.getElementById('cancel-reply');

const ctxMenu       = document.getElementById('ctx-menu');
const emojiPicker   = document.getElementById('emoji-picker');

const lightbox      = document.getElementById('lightbox');
const lightboxImg   = document.getElementById('lightbox-img');
const lightboxClose = document.getElementById('lightbox-close');

const editModal     = document.getElementById('edit-modal');
const editInput     = document.getElementById('edit-input');
const editSave      = document.getElementById('edit-save');
const editCancel    = document.getElementById('edit-cancel');

const sidebarAvatar   = document.getElementById('sidebar-avatar');
const sidebarUsername = document.getElementById('sidebar-username');
const onlineUsers     = document.getElementById('online-users');

const chatHeaderTitle = document.getElementById('chat-header-title');
const chatHeaderSub   = document.getElementById('chat-header-sub');
const roomTabBtn      = document.getElementById('room-tab-btn');

const dmConvoList     = document.getElementById('dm-convo-list');
const dmListSection   = document.getElementById('dm-list-section');

// ── AUTH ─────────────────────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await doLogin(false);
});
registerBtn.addEventListener('click', async () => { await doLogin(true); });

async function doLogin(isRegister) {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  loginError.textContent = '';
  if (!username || !password) { loginError.textContent = 'Fill in all fields.'; return; }
  try {
    const res = await fetch(`${API}/auth/${isRegister ? 'register' : 'login'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { loginError.textContent = data.error || 'Failed.'; return; }
    currentUser = { username: data.username, token: data.token };
    localStorage.setItem('chatUser', JSON.stringify(currentUser));
    enterChat();
  } catch (err) {
    loginError.textContent = 'Network error. Check worker URL in config.js';
  }
}

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('chatUser');
  currentUser = null;
  clearInterval(pollTimer);
  clearInterval(dmPollTimer);
  messages = {}; dmMessages = {};
  lastTs = 0; dmLastTs = 0;
  currentView = 'room'; currentDmUser = null;
  messagesArea.innerHTML = '<div class="day-divider"><span>TODAY</span></div>';
  loginScreen.classList.add('active');
  chatScreen.classList.remove('active');
});

// ── ENTER CHAT ───────────────────────────────────────────
function enterChat() {
  loginScreen.classList.remove('active');
  chatScreen.classList.add('active');
  sidebarUsername.textContent = currentUser.username;
  sidebarAvatar.textContent = currentUser.username[0].toUpperCase();
  showRoom();
  startPolling();
}

// ── POLLING ───────────────────────────────────────────────
function startPolling() {
  fetchMessages();
  fetchOnlineUsers();
  fetchDmConversations();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    fetchMessages();
    fetchOnlineUsers();
    fetchDmConversations();
  }, 2000);
}

async function fetchMessages() {
  try {
    const res = await fetch(`${API}/messages?since=${lastTs}`, {
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();

    // presence ping
    fetch(`${API}/presence`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    }).catch(() => {});

    data.messages.forEach(msg => {
      if (messages[msg.id]) {
        const existing = messages[msg.id];
        if (msg.updatedAt !== existing.updatedAt ||
            JSON.stringify(msg.reactions) !== JSON.stringify(existing.reactions)) {
          messages[msg.id] = msg;
          if (currentView === 'room') rerenderMessage(msg, 'room');
        }
      } else {
        messages[msg.id] = msg;
        if (currentView === 'room') renderMessage(msg, 'room');
      }
      if (msg.timestamp > lastTs) lastTs = msg.timestamp;
    });
  } catch (e) { /* silent */ }
}

async function fetchOnlineUsers() {
  try {
    const res = await fetch(`${API}/presence`, {
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    renderOnlineUsers(data.users || []);
  } catch(e) { /* silent */ }
}

async function fetchDmConversations() {
  try {
    const res = await fetch(`${API}/dm/conversations`, {
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    renderDmConvoList(data.conversations || []);
  } catch(e) { /* silent */ }
}

// ── DM THREAD POLLING ────────────────────────────────────
function startDmPolling(otherUser) {
  clearInterval(dmPollTimer);
  fetchDmMessages(otherUser);
  dmPollTimer = setInterval(() => fetchDmMessages(otherUser), 2000);
}

async function fetchDmMessages(otherUser) {
  try {
    const res = await fetch(`${API}/dm/${otherUser}?since=${dmLastTs}`, {
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    data.messages.forEach(msg => {
      if (dmMessages[msg.id]) {
        const existing = dmMessages[msg.id];
        if (msg.updatedAt !== existing.updatedAt ||
            JSON.stringify(msg.reactions) !== JSON.stringify(existing.reactions)) {
          dmMessages[msg.id] = msg;
          if (currentView === 'dm' && currentDmUser === otherUser)
            rerenderMessage(msg, 'dm');
        }
      } else {
        dmMessages[msg.id] = msg;
        if (currentView === 'dm' && currentDmUser === otherUser)
          renderMessage(msg, 'dm');
      }
      if (msg.timestamp > dmLastTs) dmLastTs = msg.timestamp;
    });
  } catch(e) { /* silent */ }
}

// ── VIEW SWITCHING ────────────────────────────────────────
roomTabBtn.addEventListener('click', showRoom);

function showRoom() {
  currentView = 'room';
  currentDmUser = null;
  clearInterval(dmPollTimer);
  dmMessages = {}; dmLastTs = 0;

  chatHeaderTitle.textContent = '#room-1';
  if (chatHeaderSub) chatHeaderSub.textContent = 'Public room';
  roomTabBtn.classList.add('active');

  messagesArea.innerHTML = '<div class="day-divider"><span>TODAY</span></div>';

  // re-render room messages already in memory
  const sorted = Object.values(messages).sort((a,b) => a.timestamp - b.timestamp);
  sorted.forEach(msg => renderMessage(msg, 'room'));

  msgInput.placeholder = 'Say something…';
  updateDmActiveState(null);
}

function openDmWith(otherUser) {
  currentView = 'dm';
  currentDmUser = otherUser;
  clearInterval(dmPollTimer);
  dmMessages = {}; dmLastTs = 0;

  chatHeaderTitle.textContent = otherUser;
  if (chatHeaderSub) chatHeaderSub.textContent = 'Direct Message';
  roomTabBtn.classList.remove('active');

  messagesArea.innerHTML = '<div class="day-divider"><span>TODAY</span></div>';
  msgInput.placeholder = `Message ${otherUser}…`;

  startDmPolling(otherUser);
  updateDmActiveState(otherUser);
}

// ── RENDER ONLINE USERS ───────────────────────────────────
function renderOnlineUsers(users) {
  onlineUsers.innerHTML = '';
  users.forEach(u => {
    if (u === currentUser.username) return;
    const el = document.createElement('div');
    el.className = 'online-user-item';
    el.innerHTML = `
      <div class="avatar">${u[0].toUpperCase()}</div>
      <span>${u}</span>
      <span class="online-dot" style="margin-left:auto"></span>
      <button class="dm-start-btn" title="Message ${u}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`;
    el.querySelector('.dm-start-btn').addEventListener('click', () => openDmWith(u));
    onlineUsers.appendChild(el);
  });
}

// ── RENDER DM CONVERSATION LIST ───────────────────────────
function renderDmConvoList(convos) {
  dmConvoList.innerHTML = '';
  if (convos.length === 0) {
    dmConvoList.innerHTML = '<div class="dm-empty">No DMs yet</div>';
    return;
  }
  convos.forEach(c => {
    const el = document.createElement('div');
    el.className = 'dm-convo-item' + (currentDmUser === c.with ? ' active' : '');
    el.dataset.user = c.with;
    const preview = c.lastPreview || '';
    const you = c.lastAuthor === currentUser.username ? 'You: ' : '';
    el.innerHTML = `
      <div class="avatar">${c.with[0].toUpperCase()}</div>
      <div class="dm-convo-info">
        <span class="dm-convo-name">${c.with}</span>
        <span class="dm-convo-preview">${you}${escapeHtml(preview.substring(0,35))}</span>
      </div>`;
    el.addEventListener('click', () => openDmWith(c.with));
    dmConvoList.appendChild(el);
  });
}

function updateDmActiveState(activeUser) {
  dmConvoList.querySelectorAll('.dm-convo-item').forEach(el => {
    el.classList.toggle('active', el.dataset.user === activeUser);
  });
}

// ── SEND MESSAGE ─────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
msgInput.addEventListener('input', () => {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
});

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text) return;
  const payload = { type: 'text', content: text, replyTo: replyTarget || null };
  msgInput.value = '';
  msgInput.style.height = 'auto';
  clearReply();
  await postMessage(payload);
}

async function postMessage(payload) {
  try {
    const endpoint = currentView === 'dm'
      ? `${API}/dm/${currentDmUser}`
      : `${API}/messages`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser.token}` },
      body: JSON.stringify(payload)
    });
    if (!res.ok) { const e = await res.json(); console.error(e.error); return; }
    const msg = await res.json();

    if (currentView === 'dm') {
      dmMessages[msg.id] = msg;
      renderMessage(msg, 'dm');
      if (msg.timestamp > dmLastTs) dmLastTs = msg.timestamp;
    } else {
      messages[msg.id] = msg;
      renderMessage(msg, 'room');
      if (msg.timestamp > lastTs) lastTs = msg.timestamp;
    }
  } catch(e) { console.error(e); }
}

// ── IMAGE UPLOAD ─────────────────────────────────────────
imgInput.addEventListener('change', async () => {
  const file = imgInput.files[0];
  if (!file) return;
  imgInput.value = '';
  const reader = new FileReader();
  reader.onload = async () => {
    const b64 = reader.result.split(',')[1];
    await postMessage({ type: 'image', content: b64, mimeType: file.type, replyTo: replyTarget || null });
    clearReply();
  };
  reader.readAsDataURL(file);
});

// ── VOICE RECORDING ──────────────────────────────────────
voiceBtn.addEventListener('mousedown', startRecording);
voiceBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
voiceBtn.addEventListener('mouseup', stopRecording);
voiceBtn.addEventListener('mouseleave', stopRecording);
voiceBtn.addEventListener('touchend', stopRecording);

async function startRecording() {
  if (mediaRecorder) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    recordingStart = Date.now();
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      const duration = Math.round((Date.now() - recordingStart) / 1000);
      stream.getTracks().forEach(t => t.stop());
      if (duration < 1) { mediaRecorder = null; return; }
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onload = async () => {
        const b64 = reader.result.split(',')[1];
        await postMessage({ type: 'voice', content: b64, mimeType: 'audio/webm', duration, replyTo: replyTarget || null });
        clearReply();
      };
      reader.readAsDataURL(blob);
      mediaRecorder = null;
    };
    mediaRecorder.start();
    voiceBtn.classList.add('recording');
    voiceIndicator.classList.remove('hidden');
  } catch(e) { alert('Microphone access denied.'); }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    voiceBtn.classList.remove('recording');
    voiceIndicator.classList.add('hidden');
  }
}

// ── RENDER MESSAGE ────────────────────────────────────────
function renderMessage(msg, view) {
  const isMine = msg.author === currentUser.username;
  const groupId = `group-${msg.id}`;
  const group = document.createElement('div');
  group.className = `msg-group ${isMine ? 'mine' : 'theirs'}`;
  group.dataset.id = msg.id;
  group.id = groupId;

  const msgStore = view === 'dm' ? dmMessages : messages;
  group.innerHTML = buildGroupHTML(msg, isMine, msgStore);
  messagesArea.appendChild(group);
  bindGroupEvents(group, msg, view);
  scrollToBottom();
}

function rerenderMessage(msg, view) {
  const group = document.getElementById(`group-${msg.id}`);
  if (!group) return;
  const isMine = msg.author === currentUser.username;
  const msgStore = view === 'dm' ? dmMessages : messages;
  group.innerHTML = buildGroupHTML(msg, isMine, msgStore);
  bindGroupEvents(group, msg, view);
}

function buildGroupHTML(msg, isMine, msgStore) {
  const ts = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const editedTag = msg.edited ? '<span class="edited-tag">(edited)</span>' : '';

  let metaHTML = isMine
    ? `<div class="msg-meta mine"><span class="ts">${ts}</span>${editedTag}<span class="name">${msg.author}</span></div>`
    : `<div class="msg-meta"><div class="avatar">${msg.author[0].toUpperCase()}</div><span class="name">${msg.author}</span><span class="ts">${ts}</span>${editedTag}</div>`;

  let bodyHTML = '';
  if (msg.deleted) {
    bodyHTML = `<div class="bubble deleted">Message deleted</div>`;
  } else {
    let inner = '';
    // reply quote
    if (msg.replyTo && msgStore[msg.replyTo]) {
      const orig = msgStore[msg.replyTo];
      const origPreview = orig.type === 'text' ? orig.content.substring(0, 60) : `[${orig.type}]`;
      inner += `<div class="reply-quote" data-scroll="${msg.replyTo}"><span class="rq-name">${orig.author}</span>${escapeHtml(origPreview)}</div>`;
    }
    // ── FIX: use msg.content (data URL) not msg.url ──
    if (msg.type === 'text') {
      inner += escapeHtml(msg.content);
    } else if (msg.type === 'image') {
      inner += `<img class="msg-img" src="${msg.content}" alt="image" data-lightbox />`;
    } else if (msg.type === 'voice') {
      const bars = buildWaveform();
      inner += `
        <div class="voice-msg">
          <button class="voice-play-btn" data-audio="${msg.content}">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M2 1l9 5-9 5V1z"/></svg>
          </button>
          <div class="voice-waveform">${bars}</div>
          <span class="voice-duration">${formatDuration(msg.duration || 0)}</span>
        </div>`;
    }
    bodyHTML = `<div class="bubble" data-id="${msg.id}">${inner}</div>`;
  }

  // reactions
  let reactHTML = '';
  if (msg.reactions && Object.keys(msg.reactions).length) {
    const agg = {};
    Object.entries(msg.reactions).forEach(([user, emoji]) => {
      if (!agg[emoji]) agg[emoji] = { count: 0, mine: false };
      agg[emoji].count++;
      if (user === currentUser.username) agg[emoji].mine = true;
    });
    reactHTML = '<div class="reactions-row">' +
      Object.entries(agg).map(([emoji, {count, mine}]) =>
        `<button class="react-chip ${mine ? 'mine' : ''}" data-id="${msg.id}" data-emoji="${emoji}">${emoji}<span class="count">${count}</span></button>`
      ).join('') + '</div>';
  }

  return metaHTML + `<div class="msg-row">${bodyHTML}</div>` + reactHTML;
}

function bindGroupEvents(group, msg, view) {
  const bubble = group.querySelector('.bubble');
  if (bubble && !msg.deleted) {
    bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); showCtxMenu(e, msg, view); });
    let pressTimer;
    bubble.addEventListener('touchstart', () => { pressTimer = setTimeout(() => showCtxMenu({ clientX: 0, clientY: 200 }, msg, view), 500); });
    bubble.addEventListener('touchend', () => clearTimeout(pressTimer));
  }

  group.querySelectorAll('.reply-quote[data-scroll]').forEach(el => {
    el.addEventListener('click', () => {
      const target = document.getElementById(`group-${el.dataset.scroll}`);
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.style.outline = '1px solid var(--accent)'; setTimeout(() => target.style.outline = '', 1200); }
    });
  });

  group.querySelectorAll('[data-lightbox]').forEach(img => {
    img.addEventListener('click', () => { lightboxImg.src = img.src; lightbox.classList.remove('hidden'); });
  });

  group.querySelectorAll('.voice-play-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const audio = new Audio(btn.dataset.audio);
      audio.play().catch(e => console.error('Audio play error:', e));
    });
  });

  group.querySelectorAll('.react-chip').forEach(chip => {
    chip.addEventListener('click', () => reactToMessage(chip.dataset.id, chip.dataset.emoji, view));
  });
}

// ── CONTEXT MENU ─────────────────────────────────────────
let ctxView = 'room';
function showCtxMenu(e, msg, view) {
  ctxTarget = msg.id;
  ctxView   = view;
  const isMine = msg.author === currentUser.username;
  const canEdit = isMine && !msg.deleted && msg.type === 'text' && (Date.now() - msg.timestamp < 15 * 60 * 1000);
  ctxMenu.querySelector('.edit-action').style.display   = canEdit ? 'block' : 'none';
  ctxMenu.querySelector('.delete-action').style.display = isMine && !msg.deleted ? 'block' : 'none';
  const x = Math.min(e.clientX || window.innerWidth / 2, window.innerWidth - 160);
  const y = Math.min(e.clientY || 200, window.innerHeight - 160);
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top  = y + 'px';
  ctxMenu.classList.remove('hidden');
}

ctxMenu.querySelectorAll('[data-action]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    const msgStore = ctxView === 'dm' ? dmMessages : messages;
    const msg = msgStore[ctxTarget];
    ctxMenu.classList.add('hidden');
    if (action === 'reply') setReply(ctxTarget, ctxView);
    if (action === 'react') showEmojiPicker(ctxTarget, ctxView);
    if (action === 'edit')  openEdit(ctxTarget, ctxView);
    if (action === 'delete') await deleteMessage(ctxTarget, ctxView);
  });
});

document.addEventListener('click', (e) => {
  if (!ctxMenu.contains(e.target)) ctxMenu.classList.add('hidden');
  if (!emojiPicker.contains(e.target)) emojiPicker.classList.add('hidden');
});

// ── REPLY ─────────────────────────────────────────────────
function setReply(msgId, view) {
  const msgStore = view === 'dm' ? dmMessages : messages;
  const msg = msgStore[msgId];
  if (!msg) return;
  replyTarget = msgId;
  const preview = msg.type === 'text' ? msg.content.substring(0, 50) : `[${msg.type}]`;
  replyPreview.textContent = `${msg.author}: ${preview}`;
  replyBar.classList.remove('hidden');
  msgInput.focus();
}

cancelReply.addEventListener('click', clearReply);
function clearReply() {
  replyTarget = null;
  replyBar.classList.add('hidden');
  replyPreview.textContent = '';
}

// ── EMOJI PICKER ──────────────────────────────────────────
let emojiPickerView = 'room';
function showEmojiPicker(msgId, view) {
  emojiPicker.dataset.targetId = msgId;
  emojiPickerView = view;
  const group = document.getElementById(`group-${msgId}`);
  if (group) {
    const rect = group.getBoundingClientRect();
    emojiPicker.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
    emojiPicker.style.top  = (rect.top - 52) + 'px';
  }
  emojiPicker.classList.remove('hidden');
}

emojiPicker.querySelectorAll('[data-emoji]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const msgId = emojiPicker.dataset.targetId;
    emojiPicker.classList.add('hidden');
    await reactToMessage(msgId, btn.dataset.emoji, emojiPickerView);
  });
});

async function reactToMessage(msgId, emoji, view) {
  try {
    const endpoint = view === 'dm'
      ? `${API}/dm/${currentDmUser}/${msgId}/react`
      : `${API}/messages/${msgId}/react`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser.token}` },
      body: JSON.stringify({ emoji })
    });
    if (!res.ok) return;
    const updated = await res.json();
    if (view === 'dm') { dmMessages[updated.id] = updated; rerenderMessage(updated, 'dm'); }
    else               { messages[updated.id] = updated;   rerenderMessage(updated, 'room'); }
  } catch(e) { console.error(e); }
}

// ── EDIT ──────────────────────────────────────────────────
let editView = 'room';
function openEdit(msgId, view) {
  const msgStore = view === 'dm' ? dmMessages : messages;
  const msg = msgStore[msgId];
  if (!msg || msg.type !== 'text') return;
  editTarget = msgId;
  editView   = view;
  editInput.value = msg.content;
  editModal.classList.remove('hidden');
  editInput.focus();
}

editCancel.addEventListener('click', () => { editModal.classList.add('hidden'); editTarget = null; });

editSave.addEventListener('click', async () => {
  if (!editTarget) return;
  const newText = editInput.value.trim();
  if (!newText) return;
  try {
    const endpoint = editView === 'dm'
      ? `${API}/dm/${currentDmUser}/${editTarget}`
      : `${API}/messages/${editTarget}`;
    const res = await fetch(endpoint, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser.token}` },
      body: JSON.stringify({ content: newText })
    });
    if (!res.ok) return;
    const updated = await res.json();
    if (editView === 'dm') { dmMessages[updated.id] = updated; rerenderMessage(updated, 'dm'); }
    else                   { messages[updated.id] = updated;   rerenderMessage(updated, 'room'); }
  } catch(e) { console.error(e); }
  editModal.classList.add('hidden');
  editTarget = null;
});

// ── DELETE ────────────────────────────────────────────────
async function deleteMessage(msgId, view) {
  try {
    const endpoint = view === 'dm'
      ? `${API}/dm/${currentDmUser}/${msgId}`
      : `${API}/messages/${msgId}`;
    const res = await fetch(endpoint, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    if (!res.ok) return;
    const updated = await res.json();
    if (view === 'dm') { dmMessages[updated.id] = updated; rerenderMessage(updated, 'dm'); }
    else               { messages[updated.id] = updated;   rerenderMessage(updated, 'room'); }
  } catch(e) { console.error(e); }
}

// ── LIGHTBOX ──────────────────────────────────────────────
lightboxClose.addEventListener('click', () => lightbox.classList.add('hidden'));
lightbox.querySelector('.lightbox-bg').addEventListener('click', () => lightbox.classList.add('hidden'));

// ── HELPERS ──────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\n/g, '<br>');
}
function scrollToBottom() { messagesArea.scrollTop = messagesArea.scrollHeight; }
function buildWaveform() {
  let html = '';
  for (let i = 0; i < 20; i++) {
    const h = 4 + Math.random() * 16;
    html += `<span style="height:${h}px"></span>`;
  }
  return html;
}
function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── AUTO-LOGIN ────────────────────────────────────────────
(function init() {
  const saved = localStorage.getItem('chatUser');
  if (saved) {
    try { currentUser = JSON.parse(saved); enterChat(); }
    catch(e) { localStorage.removeItem('chatUser'); }
  }
})();