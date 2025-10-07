import { AudioProcessor, TranslationEngine } from './audio-processor.js';

const socket = io();
let pc = null;
let localStream = null;
let currentCallId = null;
let lastIncomingOffer = null;
let audioProcessor = null;
let translationEngine = null;
let remoteLanguage = 'English';
let translatedAudioQueue = [];
let isPlayingTranslatedAudio = false;

const servers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const $ = (s) => document.querySelector(s);
const agentNameInput = $('#agentName');
const agentLanguageSelect = $('#agentLanguage');
const enableTranslationCheckbox = $('#enableTranslation');
const registerBtn = $('#registerBtn');
const toggleAvailBtn = $('#toggleAvailBtn');
const statusBadge = $('#status');
const incomingDiv = $('#incoming');
const translationStatusDiv = $('#translationStatus');
const acceptBtn = $('#acceptBtn');
const declineBtn = $('#declineBtn');
const hangupBtn = $('#hangupBtn');
const remoteAudio = $('#remoteAudio');

const agentRingtone = document.getElementById('agentRingtone');
const inCallControls = document.getElementById('inCallControls');
const muteBtn = document.getElementById('muteBtn');
const unmuteBtn = document.getElementById('unmuteBtn');

function startAgentRingtone() {
  try { agentRingtone.currentTime = 0; agentRingtone.play(); } catch (e) {}
}
function stopAgentRingtone() {
  try { agentRingtone.pause(); agentRingtone.currentTime = 0; } catch (e) {}
}
function showInCallControls(show) {
  inCallControls.style.display = show ? 'flex' : 'none';
  muteBtn.disabled = !show;
  unmuteBtn.disabled = !show;
  hangupBtn.disabled = !show;
}

function updateTranslationStatus(message) {
  translationStatusDiv.textContent = message;
}

let isRegistered = false;

registerBtn.onclick = () => {
  console.log('[agent] Go Online clicked');
  socket.emit('agent:register', {
    name: agentNameInput.value || 'Agent',
    language: agentLanguageSelect.value
  });

  if (isRegistered) return;
  isRegistered = true;
  statusBadge.textContent = 'online (available)';
  toggleAvailBtn.disabled = false;
  registerBtn.disabled = true;
};

toggleAvailBtn.onclick = () => {
  const currentlyAvailable = statusBadge.textContent.includes('available');
  const next = !currentlyAvailable;
  socket.emit('agent:setAvailable', next);
  statusBadge.textContent = next ? 'online (available)' : 'online (unavailable)';
};

socket.on('call:incoming', ({ callId, callerName, offer, callerLanguage }) => {
  console.log('[agent] incoming call event');
  currentCallId = callId;
  lastIncomingOffer = offer;
  remoteLanguage = callerLanguage || 'English';
  incomingDiv.textContent = `Call from ${callerName || 'Caller'} (${remoteLanguage})`;
  acceptBtn.disabled = false;
  declineBtn.disabled = false;
  showInCallControls(false);
  startAgentRingtone();

  updateTranslationStatus(`Caller speaks ${remoteLanguage}`);
});

socket.on('webrtc:ice', async ({ candidate }) => {
  try { await pc?.addIceCandidate(candidate); } catch (e) { console.error('ICE add error', e); }
});

socket.on('connect', () => console.log('[agent] connected', socket.id));

socket.on('call:hangup', () => {
  resetCallState();
});

socket.on('translation:text', ({ original, translated }) => {
  if (translated) {
    updateTranslationStatus(`Remote said: "${original}" → "${translated}"`);
  }
});

socket.on('translation:audio', async ({ audioData }) => {
  if (audioData) {
    const blob = new Blob([new Uint8Array(audioData)], { type: 'audio/mpeg' });
    translatedAudioQueue.push(blob);
    playNextTranslatedAudio();
  }
});

acceptBtn.onclick = async () => {
  if (!currentCallId || !lastIncomingOffer) return;
  acceptBtn.disabled = true;
  declineBtn.disabled = true;
  hangupBtn.disabled = false;
  stopAgentRingtone();

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  pc = new RTCPeerConnection(servers);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('webrtc:ice', { callId: currentCallId, candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    remoteAudio.srcObject = e.streams[0];
  };

  await pc.setRemoteDescription(new RTCSessionDescription(lastIncomingOffer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('call:accept', {
    callId: currentCallId,
    answer,
    agentLanguage: agentLanguageSelect.value
  });

  showInCallControls(true);

  const myLanguage = agentLanguageSelect.value;
  const enableTranslation = enableTranslationCheckbox.checked;

  translationEngine = new TranslationEngine(myLanguage, remoteLanguage, enableTranslation);

  if (enableTranslation && myLanguage !== remoteLanguage) {
    updateTranslationStatus(`Translation enabled: ${myLanguage} ↔ ${remoteLanguage}`);
    startTranslation();
  } else {
    updateTranslationStatus('Translation disabled or same language');
  }
};

function startTranslation() {
  if (!localStream || !translationEngine) return;

  audioProcessor = new AudioProcessor();

  audioProcessor.startRecording(localStream, async (audioBlob) => {
    const { original, translated, audioBlob: translatedAudio } = await translationEngine.processOutgoingAudio(audioBlob);

    if (translated && currentCallId) {
      socket.emit('translation:text', {
        callId: currentCallId,
        original,
        translated
      });

      if (translatedAudio) {
        const arrayBuffer = await translatedAudio.arrayBuffer();
        socket.emit('translation:audio', {
          callId: currentCallId,
          audioData: Array.from(new Uint8Array(arrayBuffer))
        });
      }

      updateTranslationStatus(`You said: "${original}"`);
    }
  });
}

function playNextTranslatedAudio() {
  if (isPlayingTranslatedAudio || translatedAudioQueue.length === 0) return;

  isPlayingTranslatedAudio = true;
  const audioBlob = translatedAudioQueue.shift();
  const audioUrl = URL.createObjectURL(audioBlob);
  const audio = new Audio(audioUrl);

  if (remoteAudio.srcObject) {
    const remoteTrack = remoteAudio.srcObject.getAudioTracks()[0];
    if (remoteTrack) remoteTrack.enabled = false;
  }

  audio.play();

  audio.onended = () => {
    URL.revokeObjectURL(audioUrl);
    isPlayingTranslatedAudio = false;

    if (remoteAudio.srcObject) {
      const remoteTrack = remoteAudio.srcObject.getAudioTracks()[0];
      if (remoteTrack) remoteTrack.enabled = true;
    }

    playNextTranslatedAudio();
  };
}

declineBtn.onclick = () => {
  if (!currentCallId) return;
  socket.emit('call:decline', { callId: currentCallId, reason: 'Agent declined' });
  stopAgentRingtone();
  resetCallState();
};

hangupBtn.onclick = () => {
  if (!currentCallId) return;
  socket.emit('call:hangup', { callId: currentCallId });
  stopAgentRingtone();
  resetCallState();
};

muteBtn.onclick = () => {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = false);
  muteBtn.disabled = true;
  unmuteBtn.disabled = false;
};

unmuteBtn.onclick = () => {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = true);
  muteBtn.disabled = false;
  unmuteBtn.disabled = true;
};

function resetCallState() {
  incomingDiv.textContent = 'No calls yet.';
  acceptBtn.disabled = true;
  declineBtn.disabled = true;
  hangupBtn.disabled = true;
  showInCallControls(false);
  lastIncomingOffer = null;
  currentCallId = null;
  remoteLanguage = 'English';
  translatedAudioQueue = [];
  isPlayingTranslatedAudio = false;

  if (audioProcessor) {
    audioProcessor.stopRecording();
    audioProcessor = null;
  }

  translationEngine = null;
  updateTranslationStatus('');

  try { pc?.getSenders().forEach(s => s.track?.stop()); } catch {}
  try { pc?.close(); } catch {}
  pc = null;
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  stopAgentRingtone();
}
