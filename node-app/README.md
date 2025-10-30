# Global Language Web (Node.js)

Express + Socket.IO server that powers the WebRTC interpreter demo. It serves the static front-end assets from `public/`, brokers signalling between callers and interpreters, and proxies the Python FastAPI service for speech, translation, and TTS.

## Getting started
```bash
cd node-app
npm install
cp .env.example .env
npm run dev
```

The app listens on `http://localhost:3000` by default. Open `http://localhost:3000/caller.html` in one browser and `http://localhost:3000/agent.html` in another to test the call flow.  
Ensure the Python FastAPI service is running (default `http://localhost:8000`) before starting the Node server.

### Configuration
- `TRANSLATOR_MODE=local` – use the Python APIs (recommended/default).
- `TRANSLATOR_MODE=remote` – proxy the hosted speech-to-speech API defined by `REMOTE_TRANSLATOR_URL`.
- `LOCAL_TRANSLATOR_URL=http://localhost:8000` – override if FastAPI is deployed elsewhere.
- `REMOTE_TRANSLATOR_URL=https://speech-to-speech-translator-qxbr.onrender.com` – override if your remote translator lives elsewhere.

## Render deployment
- **Environment**: Node
- **Build Command**: `npm install`
- **Start Command**: `npm start`

Set the following environment variables on Render:
- `TRANSLATOR_MODE=local` (or `remote` when using the hosted translator)
- `LOCAL_TRANSLATOR_URL=https://your-python-service.onrender.com`
- `REMOTE_TRANSLATOR_URL=https://speech-to-speech-translator-qxbr.onrender.com`
- (Optional) `PORT` – Render injects this automatically

## Repository layout
```
node-app/
├── public/         # Static assets (WebRTC front end)
├── server.js       # Express + Socket.IO backend
├── package.json
├── package-lock.json
└── README.md
```

The `render-build` npm script mirrors the default build command so Render can detect dependencies.
