# Global Language Web (Node.js)

Express + Socket.IO server that powers the WebRTC interpreter demo. It serves the static front-end assets from `public/`, brokers signalling between callers and interpreters, and proxies OpenAI APIs for speech/translation features.

## Getting started
```bash
cd node-app
npm install
cp .env.example .env  # add your OPENAI_API_KEY
npm run dev
```

The app listens on `http://localhost:3000` by default. Open `http://localhost:3000/caller.html` in one browser and `http://localhost:3000/agent.html` in another to test the call flow.

### Switching between OpenAI and the local Python service
- `TRANSLATOR_MODE=openai` (default) calls OpenAI Whisper/Chat/TTS APIs. Requires `OPENAI_API_KEY`.
- `TRANSLATOR_MODE=local` proxies `/api/stt`, `/api/translate`, and `/api/tts` to the Python FastAPI service (default URL `http://localhost:8000`).  
  Optionally override the target with `LOCAL_TRANSLATOR_URL`.

When running in `local` mode you can omit the OpenAI API key entirely.

## Render deployment
- **Environment**: Node
- **Build Command**: `npm install`
- **Start Command**: `npm start`

Set the following environment variables on Render:
- `OPENAI_API_KEY` – required for transcription/translation/tts routes
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
