# CHATROOM — Setup Guide

```
chat-app/
├── frontend/          ← Open index.html in browser (or serve statically)
│   ├── index.html
│   ├── style.css
│   ├── config.js      ← PUT YOUR WORKER URL HERE
│   └── app.js
└── backend/           ← Cloudflare Worker
    ├── src/index.js
    ├── wrangler.toml
    ├── package.json
    └── firebase-rules.json
```

---

## STEP 1 — Firebase Setup (from scratch)

### 1.1 Create a Firebase Project
1. Go to https://console.firebase.google.com
2. Click **Add project**
3. Enter a project name (e.g. `chatroom-app`)
4. Disable Google Analytics (optional) → **Create project**
5. Wait for it to provision → **Continue**

### 1.2 Enable Realtime Database
1. In the left sidebar → **Build** → **Realtime Database**
2. Click **Create Database**
3. Choose a region (e.g. `us-central1`)
4. Choose **Start in locked mode** → **Enable**

### 1.3 Set Database Rules (lock it down — Worker reads/writes directly)
1. In Realtime Database → **Rules** tab
2. Paste the contents of `backend/firebase-rules.json`
3. Click **Publish**

> All access goes through your Cloudflare Worker using the Firebase Admin SDK
> pattern (service account / server-side). The rules block all direct client access.

### 1.4 Get Your Firebase Config Keys
1. In the Firebase Console → click the ⚙️ gear icon → **Project settings**
2. Scroll down to **Your apps**
3. Click **Add app** → choose **Web** (</>)
4. Give it a nickname (e.g. `chatroom`) → **Register app**
5. You'll see a config block like:

```js
const firebaseConfig = {
  apiKey:            "AIzaSy...",
  authDomain:        "your-project.firebaseapp.com",
  databaseURL:       "https://your-project-default-rtdb.firebaseio.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc123"
};
```

**Save all these values** — you'll need them as Worker secrets.

---

## STEP 2 — Cloudflare Worker Setup

### 2.1 Prerequisites
```bash
node --version   # Need Node 18+
npm install -g wrangler
wrangler login   # Opens browser to authenticate with Cloudflare
```

### 2.2 Install Dependencies
```bash
cd backend
npm install
```

### 2.3 Create R2 Bucket (for images + voice)
```bash
# Create the bucket
npx wrangler r2 bucket create chatroom-media

# Enable public access
# Go to: Cloudflare Dashboard → R2 → chatroom-media → Settings → Public Access
# Enable and copy the public URL (looks like: https://pub-XXXX.r2.dev)
```

Then update `wrangler.toml`:
```toml
[vars]
R2_PUBLIC_URL = "https://pub-XXXXXXXXXXXX.r2.dev"
```

### 2.4 Deploy the Worker
```bash
npx wrangler deploy
```
Note the worker URL it gives you — something like:
`https://chatroom-worker.YOUR-SUBDOMAIN.workers.dev`

### 2.5 Set Secrets (one by one — paste values when prompted)
```bash
npx wrangler secret put JWT_SECRET
# (type any long random string, e.g.: openssl rand -base64 32)

npx wrangler secret put FIREBASE_API_KEY
# paste your Firebase apiKey

npx wrangler secret put FIREBASE_AUTH_DOMAIN
# paste your authDomain

npx wrangler secret put FIREBASE_DATABASE_URL
# paste your databaseURL (the https://....firebaseio.com URL)

npx wrangler secret put FIREBASE_PROJECT_ID
# paste your projectId

npx wrangler secret put FIREBASE_STORAGE_BUCKET
# paste your storageBucket

npx wrangler secret put FIREBASE_MESSAGING_SENDER_ID
# paste your messagingSenderId

npx wrangler secret put FIREBASE_APP_ID
# paste your appId
```

---

## STEP 3 — Frontend Setup

### 3.1 Set the Worker URL
Open `frontend/config.js` and update:
```js
const CONFIG = {
  WORKER_URL: 'https://chatroom-worker.YOUR-SUBDOMAIN.workers.dev'
};
```

### 3.2 Open / Host Frontend
**Locally** — just open `frontend/index.html` in your browser.

**For production** — deploy the `frontend/` folder to any static host:
- Cloudflare Pages: drag-and-drop the folder at pages.cloudflare.com
- Netlify: drag-and-drop at netlify.com/drop
- GitHub Pages: push to a repo and enable Pages

> If hosting on Cloudflare Pages, your worker and frontend will be on the
> same `.workers.dev` domain — no CORS issues.

---

## FEATURES RECAP

| Feature | Works |
|---|---|
| Register / Login (username + password) | ✅ |
| Single room (#room-1) | ✅ |
| Text messages with polling | ✅ |
| Reply / swap (click message context menu) | ✅ |
| React with emoji (8 options) | ✅ |
| Image sending (uploads to R2) | ✅ |
| Voice messages (hold mic button) | ✅ |
| Edit within 15 minutes | ✅ |
| Soft delete | ✅ |
| Online presence (10s heartbeat) | ✅ |
| Lightbox for images | ✅ |

---

## LOCAL DEV (Worker)

```bash
cd backend
npx wrangler dev
# Worker runs at http://localhost:8787
```

Then set `WORKER_URL` in `config.js` to `http://localhost:8787`

---

## TROUBLESHOOTING

**"Network error. Check worker URL"**
→ Check `config.js` has the correct worker URL with no trailing slash.

**"Invalid credentials"**
→ Passwords are hashed with SHA-256. If you changed JWT_SECRET, old tokens are invalid — just log in again.

**Images not loading**
→ Make sure R2 bucket public access is enabled and R2_PUBLIC_URL is correct in wrangler.toml.

**Voice not recording**
→ Browser requires HTTPS for microphone access. Use HTTPS hosting, not file:// protocol.

**Firebase quota**
→ Realtime Database free tier gives 1GB storage and 10GB/month transfer. More than enough for a small group chat.
