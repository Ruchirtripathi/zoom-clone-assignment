# Zoom Clone - Video Conferencing Platform

A fully functional video conferencing web application built to replicate Zoom's core features, design, and user experience.

## Features Implemented
- **Landing Dashboard**: A clean, professional UI matching Zoom's design with quick actions for creating, joining, and scheduling meetings.
- **Instant Meeting Creation**: One-click meeting creation with unique 10-digit IDs and shareable links.
- **Join Meeting**: Join via Meeting ID or direct link, with pre-join camera/microphone toggles and display name entry.
- **Schedule Meetings**: Schedule future meetings with date/time pickers and duration, which appear in the upcoming meetings dashboard.
- **Real-time Video/Audio**: Peer-to-peer WebRTC connections for low-latency media streaming.
- **Real-time Chat**: In-meeting text chat that persists in the database.
- **Screen Sharing**: Ability for users to share their screen (locked to one active sharer at a time).
- **Emoji Reactions**: Live ephemeral emoji reactions that float on screen.
- **Host Controls**: The meeting host can mute all participants, remove specific users, or end the meeting for everyone.
- **Responsive Design**: The UI is built with TailwindCSS and adapts perfectly to mobile, tablet, and desktop devices.
- **Mock Authentication**: Automatically assigns an identity using `localStorage` to simulate a logged-in user experience without requiring a signup flow.

## Tech Stack
- **Frontend**: Next.js 14 (React 18), TailwindCSS, WebRTC
- **Backend**: Python with FastAPI, Uvicorn, WebSockets
- **Database**: SQLite, SQLAlchemy

---

## Production Architecture

The application operates as a decoupled two-service architecture:
1. **Frontend Host (e.g. Vercel, Netlify)**: Serves the compiled Next.js static assets and React application.
2. **Backend Host (e.g. Render, Railway)**: Runs the FastAPI server handling REST endpoints, long-lived WebSocket connections for signaling, and SQLite for persistence.

The backend does **not** route media. Audio, video, and screen sharing are handled purely peer-to-peer (Mesh topology) directly between browsers using WebRTC.

## Frontend Deployment

1. Set up a project on Vercel (or preferred host) and link this repository.
2. Ensure the build command is set to: `npm run build`
3. Ensure the root directory is set to `frontend/`.
4. Add the required Environment Variables (see below).

## Backend Deployment

1. Set up a Web Service on Render or Railway.
2. Set the root directory to `backend/`.
3. Build command: `pip install -r requirements.txt`
4. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Add the required Environment Variables (see below).

## Environment Variables

### Frontend (`frontend/.env.local` for local, configure in Vercel for production)
- `NEXT_PUBLIC_API_URL`: The full URL to your backend API (e.g. `https://api.yourdomain.com`).
- `NEXT_PUBLIC_WS_URL`: The WebSocket URL for signaling (e.g. `wss://api.yourdomain.com`).
- `NEXT_PUBLIC_ICE_SERVERS`: (Optional) JSON string of custom STUN/TURN servers. Defaults to Google STUN if omitted.

### Backend (`backend/.env` for local, configure in Render/Railway for production)
- `CORS_ORIGINS`: Comma-separated list of allowed origins. **Must include the deployed frontend URL** (e.g. `https://your-frontend.vercel.app`).
- `DATABASE_PATH`: (Optional) Custom absolute path to store the SQLite database. Important for persistent volumes.

## Health Checks

Two endpoints, neither requiring auth or meeting membership:
- `GET /health` — deployment liveness probe. Returns `{"status": "ok", "database": "ok"}` (HTTP 200), or HTTP 503 if SQLite is unreachable.
- `GET /api/health` — same check under the API prefix: `{"status": "ok", "message": "API is up and running"}`.

## SQLite Persistence

**CRITICAL DEPLOYMENT NOTE:** Many PaaS providers use **ephemeral filesystems** — if the backend service restarts, the `zoom.db` SQLite file is destroyed.

**This deployment (Render free tier): SQLite data is ephemeral.** The free tier provides no persistent disk, so the database resets on every deploy, restart, and 15-minute idle spin-down. Meetings and chat history survive only while the service stays up. The application is architected for this: schema creation is automatic and idempotent on startup (`create_all`, no destructive resets), and no seed data is required — every user, meeting, and participant is created lazily at runtime, so a fresh database is immediately fully functional.

To make SQLite truly persistent instead, attach storage and point `DATABASE_PATH` at it:
- **Render (paid Starter+)**: attach a "Disk" (e.g. mounted at `/data`) and set `DATABASE_PATH=/data/zoom.db`. Disk contents survive deploys and restarts. Note: adding a disk disables zero-downtime deploys.
- **Railway**: attach a "Volume" and set `DATABASE_PATH` to a path within it (e.g. `/volume/zoom.db`).

The assignment requires SQLite, so the database engine is not substituted — the persistence strategy is a documented hosting decision.

**Free tier behavior worth knowing:** the service spins down after 15 minutes without traffic (including WebSocket messages — an active meeting keeps it alive). The next request takes ~50–60 seconds to cold-start. The `/health` endpoint can be pinged to wake it before a demo.

## WebSocket Configuration

The frontend must connect securely to the backend WebSocket in production.
Ensure you set `NEXT_PUBLIC_WS_URL` to use the `wss://` protocol (not `ws://`) to avoid mixed-content blocks by browsers on HTTPS pages.

## WebRTC Requirements

WebRTC APIs (`getUserMedia`, `getDisplayMedia`) are restricted by browsers to **secure contexts only**. The frontend must be served over `HTTPS` or `localhost`. This is handled automatically by modern platforms like Vercel.

The current application uses a mesh P2P topology (2-4 participants recommended) and public STUN servers. Restrictive enterprise networks might require deploying explicit TURN servers (configurable via `NEXT_PUBLIC_ICE_SERVERS`).

## Local Development

Frontend:
```bash
cd frontend
npm install
npm run dev
```
Backend:
```bash
cd backend
python -m venv venv
venv\Scripts\activate # Windows
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

## Production URLs

- **Frontend URL**: `https://<your-vercel-deployment-url>`
- **Backend URL**: `https://<your-backend-deployment-url>`
- **WebSocket**: `wss://<your-backend-deployment-url>`

## Troubleshooting

- **CORS Errors**: Ensure `CORS_ORIGINS` on the backend exactly matches the frontend URL (no trailing slash).
- **WebRTC/Camera Not Working**: Ensure you are accessing the frontend via `https://`.
- **Meetings Disappearing**: Your backend provider is using an ephemeral filesystem. Attach a persistent volume and configure `DATABASE_PATH`.
- **WebSocket Reconnecting Constantly**: Check if your hosting provider supports long-lived WebSocket connections, or ensure `NEXT_PUBLIC_WS_URL` is set to `wss://` and is correct.
