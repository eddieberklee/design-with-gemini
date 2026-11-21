(function (global) {
  'use strict';

  const NS = (global.GeminiApiMatrix = global.GeminiApiMatrix || {});

  function normalizeBase64(b64) {
    const cleaned = String(b64 || '')
      .replace(/[\r\n\s]+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const pad = cleaned.length % 4;
    if (pad === 2) return cleaned + '==';
    if (pad === 3) return cleaned + '=';
    return cleaned;
  }

  function base64ToUint8Array(b64) {
    const normalized = normalizeBase64(b64);
    if (!normalized) return new Uint8Array(0);
    if (
      normalized.length % 4 === 1 ||
      /[^A-Za-z0-9+/=]/.test(normalized) ||
      /=[^=]/.test(normalized) ||
      /===/.test(normalized)
    ) {
      throw new Error('Invalid base64 audio payload');
    }
    if (typeof atob === 'function') {
      let bin;
      try {
        bin = atob(normalized);
      } catch (_err) {
        throw new Error('Invalid base64 audio payload');
      }
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return bytes;
    }
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(normalized, 'base64'));
    }
    throw new Error('Base64 decoding is unavailable in this environment.');
  }

  // 32KB chunked encoding avoids RangeError: Maximum call stack size exceeded on large TTS audio.
  function uint8ArrayToBase64(bytes) {
    if (!bytes || !bytes.length) return '';
    if (typeof btoa === 'function') {
      const CHUNK = 0x8000;
      const parts = [];
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
        parts.push(String.fromCharCode.apply(null, slice));
      }
      return btoa(parts.join(''));
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes).toString('base64');
    }
    throw new Error('Base64 encoding is unavailable in this environment.');
  }

  function parsePcmParams(mimeType) {
    const mt = String(mimeType || '');
    const rateMatch = /rate=(\d+)/i.exec(mt);
    const chanMatch = /channels=(\d+)/i.exec(mt);
    const parsedRate = rateMatch ? Number(rateMatch[1]) : 24000;
    const parsedChannels = chanMatch ? Number(chanMatch[1]) : 1;
    return {
      sampleRate: parsedRate >= 8000 && parsedRate <= 96000 ? parsedRate : 24000,
      channels: parsedChannels >= 1 && parsedChannels <= 2 ? parsedChannels : 1
    };
  }

  function hasRiffWaveHeader(bytes) {
    return (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && // R
      bytes[1] === 0x49 && // I
      bytes[2] === 0x46 && // F
      bytes[3] === 0x46 && // F
      bytes[8] === 0x57 && // W
      bytes[9] === 0x41 && // A
      bytes[10] === 0x56 && // V
      bytes[11] === 0x45 // E
    );
  }

  // Gemini TTS returns signed 16-bit LITTLE-ENDIAN PCM even when mimeType says audio/L16; do not byte-swap.
  function pcm16leToWavBytes(rawBytes, sampleRate, channels) {
    const rate = sampleRate || 24000;
    const ch = channels || 1;
    const blockAlign = ch * 2;
    const rem = rawBytes.byteLength % blockAlign;
    const pcm = rem === 0
      ? rawBytes
      : rawBytes.subarray(0, rawBytes.byteLength - rem);
    const dataSize = pcm.byteLength;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);

    function writeAscii(offset, text) {
      for (let i = 0; i < text.length; i++) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    }

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, ch, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * ch * 2, true);
    view.setUint16(32, ch * 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, dataSize, true);
    new Uint8Array(buf, 44).set(pcm);
    return new Uint8Array(buf);
  }

  function audioBytesToPlayableBlob(b64, mimeType) {
    const rawBytes = base64ToUint8Array(b64);
    const mt = String(mimeType || 'audio/L16;codec=pcm;rate=24000');
    const lower = mt.toLowerCase();

    if (hasRiffWaveHeader(rawBytes)) {
      return {
        blob: typeof Blob === 'function' ? new Blob([rawBytes], { type: 'audio/wav' }) : null,
        mimeType: 'audio/wav',
        bytes: rawBytes.byteLength,
        wrapped: false
      };
    }

    if (/^audio\/(mpeg|mp3|ogg|webm|mp4|aac|flac)/.test(lower)) {
      const cleanMime = lower.split(';')[0].trim();
      return {
        blob: typeof Blob === 'function' ? new Blob([rawBytes], { type: cleanMime }) : null,
        mimeType: cleanMime,
        bytes: rawBytes.byteLength,
        wrapped: false
      };
    }

    const params = parsePcmParams(mt);
    const wavBytes = pcm16leToWavBytes(rawBytes, params.sampleRate, params.channels);
    const durationSec = params.sampleRate > 0
      ? Math.round((Math.floor(rawBytes.byteLength / (2 * params.channels)) / params.sampleRate) * 100) / 100
      : null;

    return {
      blob: typeof Blob === 'function' ? new Blob([wavBytes], { type: 'audio/wav' }) : null,
      mimeType: 'audio/wav',
      sampleRate: params.sampleRate,
      channels: params.channels,
      durationSec: durationSec,
      bytes: wavBytes.byteLength,
      wrapped: true
    };
  }

  let cachedTestTone = null;

  // Procedural 0.35s 440Hz sine tone (16kHz, mono, 16-bit LE WAV) with 10ms Hann fade-in/out.
  function generateTestToneWavBase64() {
    if (cachedTestTone) return cachedTestTone;
    const sampleRate = 16000;
    const durationSec = 0.35;
    const freqHz = 440;
    const numSamples = Math.round(sampleRate * durationSec);
    const fadeSamples = Math.round(sampleRate * 0.01);
    const pcm = new Uint8Array(numSamples * 2);
    const view = new DataView(pcm.buffer);

    for (let i = 0; i < numSamples; i++) {
      let env = 1.0;
      if (i < fadeSamples) {
        env = 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
      } else if (i > numSamples - fadeSamples) {
        const rem = numSamples - i;
        env = 0.5 * (1 - Math.cos((Math.PI * rem) / fadeSamples));
      }
      const sample = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.5 * 32767 * env;
      view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(sample))), true);
    }

    const wavBytes = pcm16leToWavBytes(pcm, sampleRate, 1);
    cachedTestTone = {
      mimeType: 'audio/wav',
      sampleRate: sampleRate,
      durationSec: durationSec,
      frequencyHz: freqHz,
      bytes: wavBytes.byteLength,
      base64: uint8ArrayToBase64(wavBytes)
    };
    return cachedTestTone;
  }

  NS.Audio = {
    base64ToUint8Array: base64ToUint8Array,
    uint8ArrayToBase64: uint8ArrayToBase64,
    parsePcmParams: parsePcmParams,
    hasRiffWaveHeader: hasRiffWaveHeader,
    pcm16leToWavBytes: pcm16leToWavBytes,
    audioBytesToPlayableBlob: audioBytesToPlayableBlob,
    generateTestToneWavBase64: generateTestToneWavBase64
  };
})(typeof window !== 'undefined' ? window : globalThis);
