import { AudioProcessor, TranslationEngine } from './audio-processor.js';

const socket = io();
socket.on('connect', () => {
  console.log('[caller] connected', socket.id);
  socket.emit('agents:request');
});

let pc = null;
let localStream = null;
let currentCallId = null;
let audioProcessor = null;
let translationEngine = null;
let remoteLanguage = 'English';
let translatedAudioQueue = [];
let isPlayingTranslatedAudio = false;

const servers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const $ = (s) => document.querySelector(s);
const callerName = $('#callerName');
const callerLanguageSelect = $('#callerLanguage');
const enableTranslationCheckbox = $('#enableTranslation');
const agentSelect = $('#agentSelect');
const callBtn = $('#callBtn');
const hangupBtn = $('#hangupBtn');
const status = $('#status');
const translationStatusDiv = $('#translationStatus');
const remoteAudio = $('#remoteAudio');

const callerRingtone = document.getElementById('callerRingtone');

function startCallerRingtone() {
  try { callerRingtone.currentTime = 0; callerRingtone.play(); } catch (e) {}
}
function stopCallerRingtone() {
  try { callerRingtone.pause(); callerRingtone.currentTime = 0; } catch (e) {}
}

function updateTranslationStatus(message) {
  translationStatusDiv.textContent = message;
}

socket.on('agents:list', (list) => {
  console.log(list);
  agentSelect.innerHTML = '';
  const available = list.filter(a => a.available);
  if (!available.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No agents available';
    agentSelect.appendChild(opt);
    callBtn.disabled = true;
    return;
  }
  callBtn.disabled = false;
  available.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    agentSelect.appendChild(opt);
  });
});

callBtn.onclick = async () => {
  const agentId = agentSelect.value;
  if (!agentId) return;
  callBtn.disabled = true;
  hangupBtn.disabled = false;
  status.textContent = 'Setting up local audio…';

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  pc = new RTCPeerConnection(servers);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate && currentCallId) {
      socket.emit('webrtc:ice', { callId: currentCallId, candidate: e.candidate });
    }
  };
  pc.ontrack = (e) => {
    remoteAudio.srcObject = e.streams[0];
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  status.textContent = 'Calling agent…';
  socket.emit('call:place', {
    agentId,
    offer,
    callerName: callerName.value || 'Caller',
    callerLanguage: callerLanguageSelect.value
  });
  startCallerRingtone();
};

socket.on('call:ringing', ({ callId, agentName }) => {
  currentCallId = callId;
  status.textContent = `Ringing ${agentName}…`;
});

socket.on('call:accepted', async ({ answer, agentLanguage }) => {
  stopCallerRingtone();
  status.textContent = 'Connected.';
  remoteLanguage = agentLanguage || 'English';

  await pc.setRemoteDescription(new RTCSessionDescription(answer));

  const myLanguage = callerLanguageSelect.value;
  const enableTranslation = enableTranslationCheckbox.checked;

  translationEngine = new TranslationEngine(myLanguage, remoteLanguage, enableTranslation);

  if (enableTranslation && myLanguage !== remoteLanguage) {
    updateTranslationStatus(`Translation enabled: ${myLanguage} ↔ ${remoteLanguage}`);
    startTranslation();
  } else {
    updateTranslationStatus('Translation disabled or same language');
  }
});

socket.on('call:declined', ({ reason }) => {
  stopCallerRingtone();
  status.textContent = `Call declined: ${reason || ''}`;
  cleanup();
});

socket.on('call:error', ({ reason }) => {
  stopCallerRingtone();
  status.textContent = `Call error: ${reason}`;
  cleanup();
});

socket.on('webrtc:ice', async ({ candidate }) => {
  try { await pc?.addIceCandidate(candidate); } catch (e) { console.error('ICE add error', e); }
});

socket.on('call:hangup', () => {
  stopCallerRingtone();
  status.textContent = 'Call ended by remote.';
  cleanup();
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

hangupBtn.onclick = () => {
  if (!currentCallId) return;
  socket.emit('call:hangup', { callId: currentCallId });
  stopCallerRingtone();
  status.textContent = 'Call ended.';
  cleanup();
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

function cleanup() {
  callBtn.disabled = false;
  hangupBtn.disabled = true;
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
}
