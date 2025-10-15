class AudioProcessor {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.recordingInterval = 5000;
    this.silenceThreshold = -55;
    this.audioContext = null;
    this.analyser = null;
    this.source = null;
    this.silenceDetectionInterval = null;
    this.consecutiveSilenceCount = 0;
    this.requiredSilenceCount = 15;
    this.isSpeaking = false;
    this.lastSpeechTime = 0;
    this.debounceDelay = 1200;
    this.minAudioSize = 3000;
    this.speechStartThreshold = -48;
    this.hasDetectedSpeech = false;
  }

  async startRecording(stream, onChunkReady) {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;
      this.source.connect(this.analyser);

      const options = { mimeType: 'audio/webm' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = 'audio/ogg';
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
          options.mimeType = 'audio/mp4';
          if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options.mimeType = '';
          }
        }
      }

      this.mediaRecorder = new MediaRecorder(stream, options);
      this.audioChunks = [];
      this.isRecording = true;
      this.consecutiveSilenceCount = 0;
      this.isSpeaking = false;
      this.lastSpeechTime = Date.now();

      this.startSilenceDetection(onChunkReady);

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
          console.log('[AudioProcessor] Audio chunk received:', event.data.size, 'bytes');
        }
      };

      this.mediaRecorder.onstop = async () => {
        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
          console.log('[AudioProcessor] Recording stopped. Total audio size:', audioBlob.size, 'bytes');
          this.audioChunks = [];

          if (audioBlob.size > this.minAudioSize && this.hasDetectedSpeech) {
            console.log('[AudioProcessor] Processing audio chunk');
            await onChunkReady(audioBlob);
            this.hasDetectedSpeech = false;
          } else {
            console.log('[AudioProcessor] Audio chunk skipped - size:', audioBlob.size, 'bytes, hadSpeech:', this.hasDetectedSpeech);
            this.hasDetectedSpeech = false;
          }
        }

        if (this.isRecording && this.mediaRecorder.state === 'inactive') {
          this.mediaRecorder.start();
          setTimeout(() => {
            if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
              this.mediaRecorder.stop();
            }
          }, this.recordingInterval);
        }
      };

      this.mediaRecorder.start();
      setTimeout(() => {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.stop();
        }
      }, this.recordingInterval);

    } catch (error) {
      console.error('Error starting recording:', error);
      throw error;
    }
  }

  startSilenceDetection(onChunkReady) {
    this.silenceDetectionInterval = setInterval(() => {
      const audioLevel = this.getAudioLevel();
      const currentTime = Date.now();

      if (audioLevel > this.speechStartThreshold) {
        this.consecutiveSilenceCount = 0;
        if (!this.isSpeaking) {
          console.log('[AudioProcessor] Speech detected! Level:', audioLevel.toFixed(2), 'dB');
        }
        this.isSpeaking = true;
        this.hasDetectedSpeech = true;
        this.lastSpeechTime = currentTime;
      } else if (audioLevel < this.silenceThreshold) {
        if (this.isSpeaking) {
          this.consecutiveSilenceCount++;
        }
      }

      if (this.isSpeaking &&
          this.consecutiveSilenceCount >= this.requiredSilenceCount &&
          currentTime - this.lastSpeechTime >= this.debounceDelay) {
        console.log('[AudioProcessor] Silence detected, stopping recording');
        this.isSpeaking = false;
        this.consecutiveSilenceCount = 0;

        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.stop();
        }
      }
    }, 150);
  }

  stopRecording() {
    this.isRecording = false;

    if (this.silenceDetectionInterval) {
      clearInterval(this.silenceDetectionInterval);
      this.silenceDetectionInterval = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    if (this.audioContext) {
      this.audioContext.close();
    }
    this.mediaRecorder = null;
    this.audioChunks = [];
  }

  getAudioLevel() {
    if (!this.analyser) return -100;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);

    const sum = dataArray.reduce((a, b) => a + b, 0);
    const average = sum / dataArray.length;
    const db = 20 * Math.log10(average / 255);

    return db;
  }
}

class TranslationEngine {
  constructor(myLanguage, remoteLanguage, enableTranslation, voiceId = 'alloy') {
    this.myLanguage = myLanguage;
    this.remoteLanguage = remoteLanguage;
    this.enableTranslation = enableTranslation;
    this.isProcessing = false;
    this.processingQueue = [];
    this.lastProcessedText = '';
    this.recentTranscriptions = [];
    this.maxRecentTranscriptions = 5;
    this.lastProcessTime = 0;
    this.minProcessInterval = 1000;
    this.transcriptionHistory = [];
    this.contextWindowSize = 3;
    this.voiceId = voiceId || 'alloy';
    this.mediaBlacklist = [
      'otter.ai', 'otter ai', 'transcribed by', 'https://', 'http://',
      'mbc news', 'cnn', 'bbc', 'fox news', 'breaking news', 'live report',
      'reporter', 'correspondent', 'broadcasting', 'anchor', 'newsroom',
      'weather report', 'traffic update', 'sports update', 'commercial break',
      'stay tuned', 'coming up next', 'brought to you by', 'www.'
    ];
    this.transcriptionArtifacts = [
      'transcribed by https://otter.ai',
      'otter.ai',
      '. .',
      '...',
      '[music]',
      '[inaudible]',
      '[silence]'
    ];
  }

  async transcribe(audioBlob) {
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob);

      const languageCode = this.getLanguageCode(this.myLanguage);
      formData.append('language', languageCode);

      console.log('[TranslationEngine] Sending to STT API, language:', languageCode);

      const response = await fetch('/api/stt', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('STT request failed with status: ' + response.status);
      }

      const data = await response.json();
      console.log('[TranslationEngine] STT API response:', data);
      return data.text || '';
    } catch (error) {
      console.error('Transcription error:', error);
      this.logToScreen('❌ Transcription API error: ' + error.message, 'error');
      return '';
    }
  }

  getLanguageCode(language) {
    const languageMap = {
      'English': 'en',
      'Spanish': 'es',
      'French': 'fr',
      'German': 'de',
      'Italian': 'it',
      'Portuguese': 'pt',
      'Russian': 'ru',
      'Japanese': 'ja',
      'Korean': 'ko',
      'Chinese': 'zh',
      'Arabic': 'ar',
      'Hindi': 'hi'
    };
    return languageMap[language] || 'en';
  }

  async translate(text, targetLanguage, context = []) {
    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, targetLang: targetLanguage, context }),
      });

      if (!response.ok) {
        throw new Error('Translation request failed');
      }

      const data = await response.json();
      return data.translated || text;
    } catch (error) {
      console.error('Translation error:', error);
      return text;
    }
  }

  async synthesizeSpeech(text, voice = 'alloy') {
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, format: 'mp3' }),
      });

      if (!response.ok) {
        throw new Error('TTS request failed');
      }

      const audioBlob = await response.blob();
      return audioBlob;
    } catch (error) {
      console.error('TTS error:', error);
      return null;
    }
  }

  async processOutgoingAudio(audioBlob) {
    console.log('[TranslationEngine] Processing audio, enabled:', this.enableTranslation, 'myLang:', this.myLanguage, 'remoteLang:', this.remoteLanguage);
    this.logToScreen('⏳ Received audio blob (' + audioBlob.size + ' bytes)', 'info');
    let record = null;

    if (!this.enableTranslation || this.myLanguage === this.remoteLanguage) {
      console.log('[TranslationEngine] Translation skipped - disabled or same language');
      this.logToScreen('⚠️ Translation disabled or same language', 'warning');
      return { original: '', translated: '', audioBlob: null };
    }

    if (this.isProcessing) {
      console.log('[TranslationEngine] Already processing, queuing');
      this.logToScreen('⌛ Queued (processing in progress)', 'info');
      this.processingQueue.push(audioBlob);
      return { original: '', translated: '', audioBlob: null };
    }

    this.isProcessing = true;

    try {
      console.log('[TranslationEngine] Step 1: Transcribing audio...');
      this.logToScreen('🎤 Processing audio...', 'info');
      const transcribed = await this.transcribe(audioBlob);
      console.log('[TranslationEngine] Transcribed:', transcribed);
      record = this.createTranscriptionRecord(transcribed);
      this.logToScreen('📝 Transcribed (saved #' + record.id + '): ' + transcribed, 'transcription');

      if (!record.normalizedText) {
        console.log('[TranslationEngine] No transcription received');
        this.updateTranscriptionRecord(record, { status: 'discarded', reason: 'empty' });
        this.logToScreen('⚠️ No speech detected in audio (saved #' + record.id + ')', 'warning');
        this.isProcessing = false;
        this.processNextInQueue();
        return { original: '', translated: '', audioBlob: null };
      }

      const normalizedText = record.normalizedText;

      if (this.isTranscriptionArtifact(normalizedText)) {
        console.log('[TranslationEngine] Transcription artifact detected, skipping:', transcribed);
        this.updateTranscriptionRecord(record, { status: 'filtered', reason: 'artifact' });
        this.logToScreen('⚠️ FILTERED (Artifact, saved #' + record.id + '): ' + transcribed, 'warning');
        this.isProcessing = false;
        this.processNextInQueue();
        return { original: '', translated: '', audioBlob: null };
      }

      if (this.containsMediaContent(normalizedText)) {
        console.log('[TranslationEngine] Media/broadcast content detected, skipping:', transcribed);
        this.updateTranscriptionRecord(record, { status: 'filtered', reason: 'media_content' });
        this.logToScreen('⚠️ FILTERED (Media Content, saved #' + record.id + '): ' + transcribed, 'warning');
        this.isProcessing = false;
        this.processNextInQueue();
        return { original: '', translated: '', audioBlob: null };
      }

      const fillerWords = ['um', 'uh', 'hmm', 'ah', 'er'];

      if (fillerWords.some(filler => normalizedText === filler) || normalizedText.length < 2) {
        console.log('[TranslationEngine] Filler word or very short text detected, skipping');
        this.updateTranscriptionRecord(record, { status: 'filtered', reason: 'short_or_filler' });
        this.logToScreen('⚠️ FILTERED (Too Short/Filler, saved #' + record.id + '): ' + transcribed, 'warning');
        this.isProcessing = false;
        this.processNextInQueue();
        return { original: '', translated: '', audioBlob: null };
      }

      if (this.isDuplicateOrRecent(normalizedText)) {
        console.log('[TranslationEngine] Duplicate or recently processed text, skipping');
        this.updateTranscriptionRecord(record, { status: 'filtered', reason: 'duplicate' });
        this.logToScreen('⚠️ FILTERED (Duplicate, saved #' + record.id + '): ' + transcribed, 'warning');
        this.isProcessing = false;
        this.processNextInQueue();
        return { original: '', translated: '', audioBlob: null };
      }

      const translationContext = this.buildContextForTranslation(record);
      this.updateTranscriptionRecord(record, {
        status: 'translating',
        contextSample: translationContext,
        voice: this.voiceId
      });

      console.log('[TranslationEngine] Step 2: Translating to', this.remoteLanguage, 'with context entries:', translationContext.length);
      this.logToScreen('🔄 Translating to ' + this.remoteLanguage + '...', 'info');
      const translated = await this.translate(transcribed, this.remoteLanguage, translationContext);
      console.log('[TranslationEngine] Translated:', translated);
      this.logToScreen('✅ Translated: ' + translated, 'translation');
      this.updateTranscriptionRecord(record, {
        status: 'translated',
        translatedText: translated,
        voice: this.voiceId
      });

      console.log('[TranslationEngine] Step 3: Synthesizing speech...');
      this.logToScreen('🔊 Synthesizing speech...', 'info');
      const translatedAudioBlob = await this.synthesizeSpeech(translated, this.voiceId);
      console.log('[TranslationEngine] Audio blob created:', translatedAudioBlob ? 'success' : 'failed');
      if (translatedAudioBlob) {
        this.logToScreen('✅ Audio ready for playback', 'success');
      }
      this.updateTranscriptionRecord(record, {
        audioGenerated: !!translatedAudioBlob,
        completedAt: new Date().toISOString(),
        voice: this.voiceId
      });

      this.lastProcessedText = transcribed;
      this.lastProcessTime = Date.now();
      this.addToRecentTranscriptions(normalizedText);
      this.isProcessing = false;
      this.processNextInQueue();
      return { original: transcribed, translated, audioBlob: translatedAudioBlob };
    } catch (error) {
      console.error('[TranslationEngine] Error processing outgoing audio:', error);
      if (record) {
        this.updateTranscriptionRecord(record, { status: 'error', reason: error.message || 'processing_error' });
      }
      this.logToScreen('❌ Error: ' + error.message, 'error');
      this.isProcessing = false;
      this.processNextInQueue();
      return { original: '', translated: '', audioBlob: null };
    }
  }

  createTranscriptionRecord(text) {
    const safeText = typeof text === 'string' ? text : '';
    const record = {
      id: this.transcriptionHistory.length + 1,
      text: safeText,
      normalizedText: safeText.toLowerCase().trim(),
      status: 'captured',
      reason: null,
      translatedText: '',
      timestamp: new Date().toISOString(),
      voice: this.voiceId
    };
    this.transcriptionHistory.push(record);
    console.log('[TranslationEngine] Transcript #' + record.id + ' captured and retained');
    return record;
  }

  updateTranscriptionRecord(record, updates = {}) {
    if (!record) return;
    Object.assign(record, updates);
    console.log('[TranslationEngine] Transcript #' + record.id + ' updated', updates);
  }

  getTranscriptionHistory() {
    return this.transcriptionHistory.map(entry => ({ ...entry }));
  }

  buildContextForTranslation(currentRecord) {
    if (!currentRecord) return [];
    const excludeIds = new Set([currentRecord.id]);
    const context = this.transcriptionHistory
      .filter(entry => !excludeIds.has(entry.id) && entry.text && entry.text.trim().length > 0 && entry.status !== 'filtered')
      .slice(-this.contextWindowSize - 1)
      .map(entry => entry.text.trim());

    return context.slice(-this.contextWindowSize);
  }

  async processNextInQueue() {
    if (this.processingQueue.length > 0) {
      const nextBlob = this.processingQueue.shift();
      setTimeout(() => this.processOutgoingAudio(nextBlob), 300);
    }
  }

  async playTranslatedAudio(text) {
    if (!text) return null;

    try {
      const audioBlob = await this.synthesizeSpeech(text, this.voiceId);
      return audioBlob;
    } catch (error) {
      console.error('Error playing translated audio:', error);
      return null;
    }
  }

  updateSettings(myLanguage, remoteLanguage, enableTranslation, voiceId = this.voiceId) {
    this.myLanguage = myLanguage;
    this.remoteLanguage = remoteLanguage;
    this.enableTranslation = enableTranslation;
    this.setVoice(voiceId);
  }

  setVoice(voiceId) {
    if (!voiceId || voiceId === this.voiceId) return;
    this.voiceId = voiceId;
    console.log('[TranslationEngine] Voice selection updated to', voiceId);
  }

  containsMediaContent(text) {
    return this.mediaBlacklist.some(phrase => text.includes(phrase.toLowerCase()));
  }

  isTranscriptionArtifact(text) {
    return this.transcriptionArtifacts.some(artifact => {
      const normalizedArtifact = artifact.toLowerCase();
      return text === normalizedArtifact || text.includes(normalizedArtifact);
    });
  }

  isDuplicateOrRecent(normalizedText) {
    if (normalizedText === this.lastProcessedText.toLowerCase()) {
      return true;
    }

    return this.recentTranscriptions.some(recent => {
      const similarity = this.calculateSimilarity(normalizedText, recent);
      return similarity > 0.8;
    });
  }

  calculateSimilarity(str1, str2) {
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;

    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.includes(shorter)) return 0.85;

    const words1 = str1.split(' ');
    const words2 = str2.split(' ');
    const commonWords = words1.filter(word => words2.includes(word));
    const similarity = (commonWords.length * 2) / (words1.length + words2.length);

    return similarity;
  }

  addToRecentTranscriptions(text) {
    this.recentTranscriptions.push(text);
    if (this.recentTranscriptions.length > this.maxRecentTranscriptions) {
      this.recentTranscriptions.shift();
    }
  }

  logToScreen(message, type = 'info') {
    const logDiv = document.getElementById('transcriptionLogs');
    if (!logDiv) return;

    const timestamp = new Date().toLocaleTimeString();
    const logEntry = document.createElement('div');

    let borderColor = '#475569';
    let bgColor = '#1e293b';
    let textColor = '#cbd5e1';

    switch(type) {
      case 'transcription':
        borderColor = '#3b82f6';
        bgColor = 'rgba(59, 130, 246, 0.1)';
        textColor = '#93c5fd';
        break;
      case 'translation':
        borderColor = '#10b981';
        bgColor = 'rgba(16, 185, 129, 0.1)';
        textColor = '#6ee7b7';
        break;
      case 'warning':
        borderColor = '#f59e0b';
        bgColor = 'rgba(245, 158, 11, 0.1)';
        textColor = '#fbbf24';
        break;
      case 'error':
        borderColor = '#ef4444';
        bgColor = 'rgba(239, 68, 68, 0.1)';
        textColor = '#fca5a5';
        break;
      case 'success':
        borderColor = '#10b981';
        bgColor = 'rgba(16, 185, 129, 0.15)';
        textColor = '#6ee7b7';
        break;
      default:
        borderColor = '#475569';
        bgColor = '#1e293b';
        textColor = '#94a3b8';
    }

    logEntry.style.borderLeftColor = borderColor;
    logEntry.style.background = bgColor;
    logEntry.style.color = textColor;

    logEntry.innerHTML = `<strong>[${timestamp}]</strong> ${message}`;
    logDiv.appendChild(logEntry);
    logDiv.scrollTop = logDiv.scrollHeight;
  }
}

export { AudioProcessor, TranslationEngine };
