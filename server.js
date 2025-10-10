// server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const multer = require('multer');
const OpenAI = require('openai').default;
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(http, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ storage: multer.memoryStorage() });

// app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.resolve(__dirname, 'public'), { extensions: ['html'] }));

app.use(express.json());

// Landing screen to choose console role
app.get('/', (_req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
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

// === OpenAI API Routes ===

// Speech-to-Text endpoint
// add: const language = req.body?.language;  // multer puts fields into req.body
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const file = new File([req.file.buffer], 'audio.webm', { type: req.file.mimetype || 'audio/webm' });
    const language = (req.body?.language || '').trim() || undefined; // e.g., 'hi', 'es', 'mr', etc.

    const result = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      language,               // <— HINT: improves accuracy/retention a lot
      temperature: 0,         // less creative, more literal
      prompt: 'Conversational phone call audio; transcribe clearly with punctuation.',
    });

    res.json({ text: result.text || '' });
  } catch (err) {
    console.error('STT error:', err?.message || err);
    res.status(500).json({ error: 'STT failed' });
  }
});


// Translation endpoint
app.post('/api/translate', async (req, res) => {
  try {
    const { text, targetLang, context = [] } = req.body;
    const sourceText = typeof text === 'string' ? text.trim() : '';
    const targetLanguage = typeof targetLang === 'string' ? targetLang.trim() : '';
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

    const chat = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You are a professional interpreter. Your ONLY task is to translate the provided utterance into ${targetLanguage}.
- Return only the translated text with no additional commentary, labels, or explanations.
- Preserve the speaker's intent, tone, and level of formality.
- When context is provided, use it to disambiguate meaning, but never invent new information.
- If multiple sentences are present, translate each in order.
- Never respond conversationally and never refuse unless translation is impossible.
If translation is impossible, respond with "[UNABLE_TO_TRANSLATE]".`,
        },
        { role: 'user', content: contextBlock },
      ],
    });

    const translated = chat.choices?.[0]?.message?.content?.trim() || sourceText;
    res.json({ translated });
  } catch (err) {
    console.error('Translation error:', err?.message || err);
    res.status(500).json({ error: 'Translation failed' });
  }
});

// Text-to-Speech endpoint
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'alloy', format = 'mp3' } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Field text is required' });
    }

    const response = await openai.audio.speech.create({
      model: 'tts-1',
      voice,
      input: text,
      response_format: format,
    });

    const arrayBuffer = await response.arrayBuffer();

    const contentType = format === 'wav' ? 'audio/wav'
      : format === 'opus' ? 'audio/ogg'
      : format === 'flac' ? 'audio/flac'
      : format === 'aac' ? 'audio/aac'
      : 'audio/mpeg';

    res.set('Content-Type', contentType);
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('TTS error:', err?.message || err);
    res.status(500).json({ error: 'TTS failed' });
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

http.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
