class AudioProcessor {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.recordingInterval = 4000;
    this.silenceThreshold = -40;
    this.audioContext = null;
    this.analyser = null;
    this.source = null;
    this.silenceDetectionInterval = null;
    this.consecutiveSilenceCount = 0;
    this.requiredSilenceCount = 3;
    this.isSpeaking = false;
    this.lastSpeechTime = 0;
    this.debounceDelay = 800;
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
        }
      };

      this.mediaRecorder.onstop = async () => {
        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
          this.audioChunks = [];

          if (audioBlob.size > 3000) {
            await onChunkReady(audioBlob);
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

      if (audioLevel > this.silenceThreshold) {
        this.consecutiveSilenceCount = 0;
        this.isSpeaking = true;
        this.lastSpeechTime = currentTime;
      } else {
        if (this.isSpeaking) {
          this.consecutiveSilenceCount++;
        }
      }

      if (this.isSpeaking &&
          this.consecutiveSilenceCount >= this.requiredSilenceCount &&
          currentTime - this.lastSpeechTime >= this.debounceDelay) {
        this.isSpeaking = false;
        this.consecutiveSilenceCount = 0;

        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.stop();
        }
      }
    }, 200);
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
  constructor(myLanguage, remoteLanguage, enableTranslation) {
    this.myLanguage = myLanguage;
    this.remoteLanguage = remoteLanguage;
    this.enableTranslation = enableTranslation;
    this.isProcessing = false;
    this.processingQueue = [];
    this.lastProcessedText = '';
    this.minTextLength = 3;
  }

  async transcribe(audioBlob) {
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob);

      const response = await fetch('/api/stt', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('STT request failed');
      }

      const data = await response.json();
      return data.text || '';
    } catch (error) {
      console.error('Transcription error:', error);
      return '';
    }
  }

  async translate(text, targetLanguage) {
    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, targetLang: targetLanguage }),
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

    if (!this.enableTranslation || this.myLanguage === this.remoteLanguage) {
      console.log('[TranslationEngine] Translation skipped - disabled or same language');
      return { original: '', translated: '', audioBlob: null };
    }

    if (this.isProcessing) {
      console.log('[TranslationEngine] Already processing, queuing');
      this.processingQueue.push(audioBlob);
      return { original: '', translated: '', audioBlob: null };
    }

    this.isProcessing = true;

    try {
      console.log('[TranslationEngine] Step 1: Transcribing audio...');
      const transcribed = await this.transcribe(audioBlob);
      console.log('[TranslationEngine] Transcribed:', transcribed);

      if (!transcribed || transcribed.trim().length < this.minTextLength) {
        console.log('[TranslationEngine] Text too short or empty, skipping');
        this.isProcessing = false;
        this.processNextInQueue();
        return { original: '', translated: '', audioBlob: null };
      }

      const normalizedText = transcribed.toLowerCase().trim();
      const fillerWords = ['um', 'uh', 'hmm', 'ah', 'er', 'like', 'you know', 'thank you', 'thanks'];

      if (fillerWords.some(filler => normalizedText === filler || normalizedText.length < 5)) {
        console.log('[TranslationEngine] Filler word or very short text detected, skipping');
        this.isProcessing = false;
        this.processNextInQueue();
        return { original: '', translated: '', audioBlob: null };
      }

      if (normalizedText === this.lastProcessedText.toLowerCase()) {
        console.log('[TranslationEngine] Duplicate text, skipping');
        this.isProcessing = false;
        this.processNextInQueue();
        return { original: '', translated: '', audioBlob: null };
      }

      console.log('[TranslationEngine] Step 2: Translating to', this.remoteLanguage);
      const translated = await this.translate(transcribed, this.remoteLanguage);
      console.log('[TranslationEngine] Translated:', translated);

      console.log('[TranslationEngine] Step 3: Synthesizing speech...');
      const translatedAudioBlob = await this.synthesizeSpeech(translated);
      console.log('[TranslationEngine] Audio blob created:', translatedAudioBlob ? 'success' : 'failed');

      this.lastProcessedText = transcribed;
      this.isProcessing = false;
      this.processNextInQueue();
      return { original: transcribed, translated, audioBlob: translatedAudioBlob };
    } catch (error) {
      console.error('[TranslationEngine] Error processing outgoing audio:', error);
      this.isProcessing = false;
      this.processNextInQueue();
      return { original: '', translated: '', audioBlob: null };
    }
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
      const audioBlob = await this.synthesizeSpeech(text);
      return audioBlob;
    } catch (error) {
      console.error('Error playing translated audio:', error);
      return null;
    }
  }

  updateSettings(myLanguage, remoteLanguage, enableTranslation) {
    this.myLanguage = myLanguage;
    this.remoteLanguage = remoteLanguage;
    this.enableTranslation = enableTranslation;
  }
}

export { AudioProcessor, TranslationEngine };
