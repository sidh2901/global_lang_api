// server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const multer = require('multer');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const WebSocket = require('ws');
const io = new Server(http, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const TRANSLATOR_MODE = (process.env.TRANSLATOR_MODE || 'local').toLowerCase();
const USE_LOCAL_TRANSLATOR = TRANSLATOR_MODE === 'local';
const USE_REMOTE_TRANSLATOR = TRANSLATOR_MODE === 'remote';
const LOCAL_TRANSLATOR_URL = process.env.LOCAL_TRANSLATOR_URL || 'http://localhost:8000';
const REMOTE_TRANSLATOR_URL = process.env.REMOTE_TRANSLATOR_URL || 'https://speech-to-speech-translator-qxbr.onrender.com';
const upload = multer({ storage: multer.memoryStorage() });
const wss = new WebSocket.Server({ server: http, path: '/audio-stream' });

function pcmBuffersToWav(buffers, sampleRate = 16000, numChannels = 1) {
  const pcmData = Buffer.concat(buffers);
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = pcmData.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (PCM)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // BitsPerSample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, 44);
  return buffer;
}

async function translatePcmChunk({ pcmBuffers, sourceLang, targetLang, sampleRate = 16000 }) {
  if (!USE_REMOTE_TRANSLATOR) {
    return { text: '', translated: '', audioBase64: null, contentType: null };
  }
  const wavBuffer = pcmBuffersToWav(pcmBuffers, sampleRate, 1);
  const form = new FormData();
  form.append('file', new File([wavBuffer], 'audio.wav', { type: 'audio/wav' }));
  form.append('source_lang', sourceLang || 'en');
  form.append('target_lang', targetLang || 'en');

  const response = await fetchRemote('/translate-audio/', {
    method: 'POST',
    body: form,
  });

  const arrayBuffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') || 'audio/wav';
  const recognizedHeader = response.headers.get('x-recognized-text');
  const translatedHeader = response.headers.get('x-translated-text');
  const recognizedText = decodeHeaderToText(recognizedHeader);
  const translatedText = decodeHeaderToText(translatedHeader);

  return {
    text: recognizedText,
    translated: translatedText,
    audioBase64: Buffer.from(arrayBuffer).toString('base64'),
    contentType,
  };
}

class LocalServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function fetchLocal(pathname, init) {
  const url = new URL(pathname, LOCAL_TRANSLATOR_URL).toString();
  const response = await fetch(url, init);
  if (!response.ok) {
    let errorDetail = `${response.status} ${response.statusText}`;
    const clone = response.clone();
    try {
      const data = await clone.json();
      errorDetail = typeof data === 'string' ? data : JSON.stringify(data);
    } catch {
      try {
        errorDetail = await response.text();
      } catch {
        // ignore
      }
    }
    throw new LocalServiceError(response.status, errorDetail);
  }
  return response;
}

class RemoteServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function fetchRemote(pathname, init) {
  const url = new URL(pathname, REMOTE_TRANSLATOR_URL).toString();
  const response = await fetch(url, init);
  if (!response.ok) {
    let errorDetail = `${response.status} ${response.statusText}`;
    const clone = response.clone();
    try {
      const data = await clone.json();
      if (data?.detail) {
        errorDetail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
      } else {
        errorDetail = typeof data === 'string' ? data : JSON.stringify(data);
      }
    } catch {
      try {
        errorDetail = await response.text();
      } catch {
        // ignore
      }
    }
    throw new RemoteServiceError(response.status, errorDetail);
  }
  return response;
}

function fileFromUpload(upload, fallbackName) {
  const filename = upload.originalname || fallbackName || 'audio.webm';
  const mimetype = upload.mimetype || 'application/octet-stream';
  return new File([upload.buffer], filename, { type: mimetype });
}

// app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.resolve(__dirname, 'public'), { extensions: ['html'] }));

app.use(express.json());

// Landing screen to choose console role
app.get('/', (_req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

app.get('/api/config', (_req, res) => {
  res.json({
    translatorMode: TRANSLATOR_MODE,
    localTranslatorUrl: USE_LOCAL_TRANSLATOR ? LOCAL_TRANSLATOR_URL : null,
    remoteTranslatorUrl: USE_REMOTE_TRANSLATOR ? REMOTE_TRANSLATOR_URL : null,
  });
});

// In-memory agent registry: { socketId: { name, available, busy } }
const agents = new Map();

function currentAgents() {
  return [...agents.entries()].map(([id, a]) => ({
    id,
    name: a.name,
    available: !!a.available && !a.busy
  }));
}
function broadcastAgents() {
  const list = currentAgents();
  console.log('[server] broadcast agents', list);
  io.emit('agents:list', list);
}
function sendAgentsList(sock) {
  const list = currentAgents();
  console.log('[server] send list to', sock.id, list);
  sock.emit('agents:list', list);
}

// --- Debug endpoint so you can verify server state in the browser ---
app.get('/api/debug/agents', (_req, res) => res.json(currentAgents()));

// === API Routes ===

// Speech-to-Text endpoint (proxy to Python)
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    if (!USE_LOCAL_TRANSLATOR) {
      return res.status(501).json({ error: 'Local translator disabled.' });
    }

    const form = new FormData();
    form.append('file', fileFromUpload(req.file, 'audio.webm'));
    const languageHint = (req.body?.language || '').trim();
    if (languageHint) form.append('language_hint', languageHint);
    const targetLang = (req.body?.targetLang || '').trim().toLowerCase();
    if (targetLang) form.append('target_language', targetLang);

    const response = await fetchLocal('/transcribe', {
      method: 'POST',
      body: form,
    });
    const data = await response.json();
    res.json({
      text: data.transcript || data.text || '',
      translated: data.translated || '',
      targetLanguage: data.target_language || targetLang || null,
      mode: 'local',
    });
  } catch (err) {
    if (err instanceof LocalServiceError) {
      console.error('STT local error:', err.message);
      return res.status(err.status).json({ error: err.message, mode: 'local' });
    }
    console.error('STT error:', err?.message || err);
    res.status(500).json({ error: 'STT failed' });
  }
});


// Translation endpoint
app.post('/api/translate', async (req, res) => {
  try {
    const { text, targetLang, context = [] } = req.body;
    const sourceText = typeof text === 'string' ? text.trim() : '';
    const targetLanguageRaw = typeof targetLang === 'string' ? targetLang.trim() : '';
    const targetLanguage = targetLanguageRaw.toLowerCase();
    const contextItems = Array.isArray(context)
      ? context
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter((entry) => entry.length > 0)
      : [];

    if (!sourceText || !targetLanguage) {
      return res.status(400).json({ error: 'Both text and targetLang are required' });
    }

    const contextBlock = contextItems.length
      ? `Recent context:\n${contextItems.map((line, idx) => `${idx + 1}. ${line}`).join('\n')}\n\nCurrent utterance:\n${sourceText}`
      : sourceText;

    if (!USE_LOCAL_TRANSLATOR) {
      return res.status(501).json({ error: 'Local translator disabled.' });
    }

    const response = await fetchLocal('/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: sourceText,
        target_language: targetLanguage,
        context: contextItems,
      }),
    });
    const data = await response.json();
    res.json({ translated: data.translated || sourceText, mode: 'local' });
  } catch (err) {
    if (err instanceof LocalServiceError) {
      console.error('Translation local error:', err.message);
      return res.status(err.status).json({ error: err.message, mode: 'local' });
    }
    console.error('Translation error:', err?.message || err);
    res.status(500).json({ error: 'Translation failed' });
  }
});

// Text-to-Speech endpoint (default voice + optional cloned sample)
app.post('/api/tts', async (req, res) => {
  try {
    const { text, targetLang, speakerSample } = req.body;
    const normalizedTargetLang = typeof targetLang === 'string' ? targetLang.trim().toLowerCase() : '';

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Field text is required' });
    }

    if (!USE_LOCAL_TRANSLATOR) {
      return res.status(501).json({ error: 'Local translator disabled.' });
    }

    const form = new FormData();
    form.append('text', text);
    if (normalizedTargetLang) {
      form.append('target_language', normalizedTargetLang);
    }
    if (speakerSample) {
      const buffer = Buffer.from(speakerSample, 'base64');
      form.append('speaker', buffer, 'speaker.wav');
    }

    const response = await fetchLocal('/tts/clone', {
      method: 'POST',
      body: form,
    });
    const arrayBuffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/wav');
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    if (err instanceof LocalServiceError) {
      console.error('TTS local error:', err.message);
      return res.status(err.status).json({ error: err.message, mode: 'local' });
    }
    console.error('TTS error:', err?.message || err);
    res.status(500).json({ error: 'TTS failed' });
  }
});

function decodeHeaderToText(value) {
  if (!value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch (err) {
    console.warn('Failed to decode header text:', err?.message || err);
    return '';
  }
}

app.post('/api/remote/translate-audio', upload.single('audio'), async (req, res) => {
  let sourceLang = '';
  let targetLang = '';
  try {
    if (!USE_REMOTE_TRANSLATOR) {
      return res.status(501).json({ error: 'Remote translator disabled.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    sourceLang = (req.body?.sourceLang || '').trim().toLowerCase();
    targetLang = (req.body?.targetLang || '').trim().toLowerCase();

    if (!sourceLang || !targetLang) {
      return res.status(400).json({ error: 'Both sourceLang and targetLang are required' });
    }

    const form = new FormData();
    form.append('file', fileFromUpload(req.file, 'audio.webm'));
    form.append('source_lang', sourceLang);
    form.append('target_lang', targetLang);

    const response = await fetchRemote('/translate-audio/', {
      method: 'POST',
      body: form,
    });

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'audio/wav';
    const recognizedHeader = response.headers.get('x-recognized-text');
    const translatedHeader = response.headers.get('x-translated-text');
    const recognizedText = decodeHeaderToText(recognizedHeader);
    const translatedText = decodeHeaderToText(translatedHeader);

    res.json({
      text: recognizedText,
      translated: translatedText,
      audioBase64: Buffer.from(arrayBuffer).toString('base64'),
      contentType,
      mode: 'remote',
      sourceLang,
      targetLang,
    });
  } catch (err) {
    if (err instanceof RemoteServiceError || err instanceof Error) {
      const status = Number(err?.status ?? err?.statusCode ?? 500);
      const message = String(err?.message ?? 'Remote translator error');
      const notRecognized = message.toLowerCase().includes('could not be recognized') || status === 204;
      if (notRecognized) {
        console.warn('Remote translator returned no speech detected');
        return res.json({
          text: '',
          translated: '',
          audioBase64: null,
          contentType: null,
          mode: 'remote',
          sourceLang,
          targetLang,
          reason: 'no_speech_detected',
        });
      }
      console.error('Remote translation error:', message);
      return res.status(status || 500).json({ error: message, mode: 'remote' });
    }
    console.error('Remote translate-audio error:', err?.message || err);
    res.status(500).json({ error: 'Remote translate audio failed' });
  }
});

io.on('connection', (socket) => {
  console.log('[server] socket connected', socket.id);

  // Push current list to this client immediately
  sendAgentsList(socket);

  // Allow clients to request the list explicitly
  socket.on('agents:request', () => sendAgentsList(socket));

  // === Agent lifecycle ===
  socket.on('agent:register', ({ name }) => {
    const n = (name || 'Agent').trim();
    agents.set(socket.id, { name: n, available: true, busy: false });
    console.log('[server] agent registered', socket.id, n);
    socket.join('agents');
    broadcastAgents();
  });

  socket.on('agent:setAvailable', (available) => {
    const a = agents.get(socket.id);
    if (a) a.available = !!available;
    console.log('[server] agent availability', socket.id, !!available);
    broadcastAgents();
  });

  // === Calls ===
  socket.on('call:place', ({ agentId, offer, callerName, callerLanguage }) => {
    const agent = agents.get(agentId);
    if (!agent) {
      console.warn('[server] call error: agent not found', agentId);
      socket.emit('call:error', { reason: 'Agent not found or disconnected.' });
      return;
    }
    if (!agent.available || agent.busy) {
      console.warn('[server] call error: agent unavailable', agentId);
      socket.emit('call:error', { reason: 'Agent is not available.' });
      return;
    }
    agent.busy = true;
    broadcastAgents();

    const callId = `${socket.id}_${agentId}`;
    socket.join(callId);
    const agentSock = io.sockets.sockets.get(agentId);
    if (agentSock) agentSock.join(callId);

    io.to(agentId).emit('call:incoming', {
      callId,
      fromSocketId: socket.id,
      callerName: callerName || 'Caller',
      callerLanguage: callerLanguage || 'English',
      offer
    });
    socket.emit('call:ringing', { callId, agentName: agent.name });
  });

  socket.on('call:accept', ({ callId, answer, agentLanguage }) => {
    socket.to(callId).emit('call:accepted', { answer, agentLanguage: agentLanguage || 'English' });
  });

  socket.on('call:decline', ({ callId, reason }) => {
    socket.to(callId).emit('call:declined', { reason: reason || 'Declined' });
    const a = agents.get(socket.id);
    if (a) { a.busy = false; broadcastAgents(); }
    io.socketsLeave(callId);
  });

  socket.on('webrtc:ice', ({ callId, candidate }) => {
    socket.to(callId).emit('webrtc:ice', { candidate });
  });

  socket.on('call:hangup', ({ callId }) => {
    socket.to(callId).emit('call:hangup');
    io.socketsLeave(callId);
    const a = agents.get(socket.id);
    if (a) { a.busy = false; broadcastAgents(); }
  });

  socket.on('translation:text', ({ callId, original, translated }) => {
    socket.to(callId).emit('translation:text', { original, translated });
  });

  socket.on('translation:audio', ({ callId, audioData }) => {
    socket.to(callId).emit('translation:audio', { audioData });
  });

  socket.on('disconnect', () => {
    if (agents.has(socket.id)) {
      console.log('[server] agent disconnected', socket.id);
      agents.delete(socket.id);
      broadcastAgents();
    } else {
      console.log('[server] socket disconnected', socket.id);
    }
  });
});

// === Raw PCM streaming over WebSocket (experimental) ===
wss.on('connection', (ws) => {
  console.log('[ws] audio-stream client connected');
  let pcmBuffers = [];
  let sourceLang = 'en';
  let targetLang = 'en';
  let sampleRate = 16000;
  let isTranslating = false;
  const minBytes = 32000; // ~1s of 16kHz mono PCM

  async function processFrames(force = false) {
    if (isTranslating) return;
    if (!pcmBuffers.length) return;
    const totalSize = pcmBuffers.reduce((sum, b) => sum + b.length, 0);
    if (!force && totalSize < minBytes) return;
    const frames = pcmBuffers;
    pcmBuffers = [];
    isTranslating = true;
    try {
      const result = await translatePcmChunk({ pcmBuffers: frames, sourceLang, targetLang, sampleRate });
      const payload = JSON.stringify({
        type: 'translation',
        original: result.text || '',
        translated: result.translated || '',
        hasAudio: !!result.audioBase64,
        contentType: result.contentType || 'audio/wav'
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        if (result.audioBase64) {
          const audioBuffer = Buffer.from(result.audioBase64, 'base64');
          ws.send(audioBuffer);
        }
      }
    } catch (err) {
      console.error('[ws] translation error:', err?.message || err);
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('could not be recognized') || msg.includes('no speech')) {
        // keep the frames and try again with more audio
        pcmBuffers = frames.concat(pcmBuffers);
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', error: err?.message || 'translation_failed' }));
      }
    } finally {
      isTranslating = false;
    }
  }

  const flushInterval = setInterval(() => {
    processFrames().catch((err) => console.error('[ws] flush error', err?.message || err));
  }, 1000);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'config') {
          sourceLang = (msg.sourceLang || 'en').toLowerCase();
          targetLang = (msg.targetLang || 'en').toLowerCase();
          sampleRate = Number(msg.sampleRate) || 16000;
          console.log('[ws] config set', sourceLang, '->', targetLang, 'rate:', sampleRate);
        }
      } catch (e) {
        console.warn('[ws] failed to parse message', e);
      }
      return;
    }

    pcmBuffers.push(Buffer.from(data));

    const totalSize = pcmBuffers.reduce((sum, b) => sum + b.length, 0);
    if (totalSize >= minBytes) {
      processFrames().catch((err) => console.error('[ws] immediate flush error', err?.message || err));
    }
  });

  ws.on('close', () => {
    console.log('[ws] audio-stream client disconnected');
    processFrames(true).catch(() => {});
    clearInterval(flushInterval);
    pcmBuffers = [];
  });

  ws.on('error', (err) => {
    console.error('[ws] error:', err.message || err);
    processFrames(true).catch(() => {});
    clearInterval(flushInterval);
    pcmBuffers = [];
  });
});

http.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
