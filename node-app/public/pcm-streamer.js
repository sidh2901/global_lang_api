const DEFAULT_TARGET_RATE = 16000;

class PCMStreamer {
  constructor(mediaStream, {
    wsUrl = null,
    targetSampleRate = DEFAULT_TARGET_RATE,
    sourceLang = 'en',
    targetLang = 'en'
  } = {}) {
    this.mediaStream = mediaStream;
    this.targetSampleRate = targetSampleRate;
    this.wsUrl = wsUrl || PCMStreamer.buildDefaultWsUrl();
    this.sourceLang = sourceLang;
    this.targetLang = targetLang;
    this.audioContext = null;
    this.workletNode = null;
    this.ws = null;
    this.isStarting = false;
    this.lastContentType = 'audio/wav';
    this.onTranslation = null;
    this.onAudio = null;
  }

  static buildDefaultWsUrl() {
    const { protocol, host } = window.location;
    const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${host}/audio-stream`;
  }

  async start() {
    if (this.isStarting || this.workletNode) return;
    this.isStarting = true;
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 48000
      });
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      await this.audioContext.audioWorklet.addModule('/pcm-worklet-processor.js');
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-downsampler', {
        processorOptions: {
          targetSampleRate: this.targetSampleRate,
          chunkSize: 1024
        }
      });

      this.workletNode.port.onmessage = (event) => {
        const pcm = event.data;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(pcm);
        }
      };

      // Do not connect to destination; this node is a tap only.
      source.connect(this.workletNode);

      this.openSocket();
      console.log('[PCMStreamer] Started with target rate', this.targetSampleRate, 'WS:', this.wsUrl);
    } catch (err) {
      console.error('[PCMStreamer] start failed:', err);
    } finally {
      this.isStarting = false;
    }
  }

  openSocket() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
    this.ws = new WebSocket(this.wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('[PCMStreamer] WebSocket connected');
      const config = {
        type: 'config',
        sourceLang: this.sourceLang,
        targetLang: this.targetLang,
        sampleRate: this.targetSampleRate
      };
      this.ws.send(JSON.stringify(config));
    };

    this.ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'translation') {
            this.lastContentType = msg.contentType || this.lastContentType || 'audio/wav';
            if (typeof this.onTranslation === 'function') {
              this.onTranslation(msg);
            } else {
              console.log('[PCMStreamer] Translation', msg);
            }
          } else if (msg.type === 'error') {
            console.warn('[PCMStreamer] Translator error', msg.error);
          }
        } catch (e) {
          console.warn('[PCMStreamer] Failed to parse message', e);
        }
        return;
      }

      const contentType = this.lastContentType || 'audio/wav';
      const blob = new Blob([event.data], { type: contentType });
      if (typeof this.onAudio === 'function') {
        this.onAudio(blob);
      } else {
        console.log('[PCMStreamer] Audio chunk received', blob.size, 'bytes');
      }
    };

    this.ws.onerror = (err) => {
      console.error('[PCMStreamer] WebSocket error', err?.message || err);
    };

    this.ws.onclose = () => {
      console.log('[PCMStreamer] WebSocket closed');
    };
  }

  stop() {
    try {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      if (this.workletNode) {
        this.workletNode.disconnect();
        this.workletNode = null;
      }
      if (this.audioContext) {
        this.audioContext.close();
        this.audioContext = null;
      }
    } catch (err) {
      console.error('[PCMStreamer] stop error:', err);
    }
  }
}

export { PCMStreamer };
