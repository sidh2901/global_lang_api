class PcmDownsamplerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options?.processorOptions || {};
    this.targetSampleRate = processorOptions.targetSampleRate || 16000;
    this.chunkSize = processorOptions.chunkSize || 1024;
    this.sourceCursor = 0;
    this.ratio = sampleRate / this.targetSampleRate;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    const channelData = input[0];
    const inputLength = channelData.length;
    const estimatedOutput = Math.ceil((inputLength + this.sourceCursor) / this.ratio);
    const output = new Int16Array(estimatedOutput);

    let writeIndex = 0;
    let readIndex = this.sourceCursor;

    while (readIndex < inputLength) {
      const sample = channelData[Math.floor(readIndex)];
      const clamped = Math.max(-1, Math.min(1, sample));
      output[writeIndex++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      readIndex += this.ratio;
    }

    // Preserve fractional position for next buffer
    this.sourceCursor = readIndex - inputLength;

    if (writeIndex > 0) {
      const slice = output.subarray(0, writeIndex);
      this.port.postMessage(slice, [slice.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsamplerProcessor);
