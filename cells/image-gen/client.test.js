'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('./client.js');

test('rankImageModels prioritizes Nano Banana Pro and 3.1 Flash Image over 2.5 Flash Image', () => {
  const ranked = client.rankImageModels([
    { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-image-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-pro-image-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/imagen-3.0-generate-002', supportedGenerationMethods: ['predict'] }
  ]);

  assert.deepEqual(
    ranked.map((m) => m.id),
    [
      'gemini-3-pro-image-preview',
      'gemini-3.1-flash-image-preview',
      'gemini-2.5-flash-image'
    ]
  );
});

test('buildGenerateRequest includes responseModalities and imageConfig.aspectRatio', () => {
  const req = client.buildGenerateRequest('A stoneware mug', { aspectRatio: '16:9' });
  assert.equal(req.contents[0].parts[0].text, 'A stoneware mug');
  assert.deepEqual(req.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.deepEqual(req.generationConfig.imageConfig, { aspectRatio: '16:9' });
});

test('buildGenerateRequest omits imageConfig when omitImageConfig is true', () => {
  const req = client.buildGenerateRequest('A stoneware mug', {
    aspectRatio: '16:9',
    omitImageConfig: true
  });
  assert.equal(req.generationConfig.imageConfig, undefined);
});

test('parseGenerateResponse extracts camelCase inlineData and text', () => {
  const parsed = client.parseGenerateResponse({
    candidates: [
      {
        finishReason: 'STOP',
        content: {
          parts: [
            { text: 'Here is your image.' },
            { inlineData: { mimeType: 'image/png', data: 'QUJD' } }
          ]
        }
      }
    ]
  });

  assert.deepEqual(parsed.image, { mimeType: 'image/png', data: 'QUJD' });
  assert.equal(parsed.text, 'Here is your image.');
  assert.equal(parsed.blockReason, '');
});

test('parseGenerateResponse extracts snake_case inline_data and blockReason', () => {
  const parsed = client.parseGenerateResponse({
    promptFeedback: { blockReason: 'SAFETY' },
    candidates: []
  });
  assert.equal(parsed.image, null);
  assert.equal(parsed.blockReason, 'SAFETY');

  const snake = client.parseGenerateResponse({
    candidates: [
      {
        content: {
          parts: [{ inline_data: { mime_type: 'image/webp', data: 'WFlZ' } }]
        }
      }
    ]
  });
  assert.deepEqual(snake.image, { mimeType: 'image/webp', data: 'WFlZ' });
});
