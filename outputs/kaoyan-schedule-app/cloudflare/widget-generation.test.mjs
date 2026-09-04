import assert from 'node:assert/strict';
import test from 'node:test';

import { widgetGenerationInternals } from './widget-generation.js';

const validate = (overrides = {}) => widgetGenerationInternals.validateArtifact({
  html: '<section><button type="button">重置</button></section>',
  css: 'button{padding:8px}',
  js: 'function resetCard(){ document.querySelector("button").textContent = "已重置"; }',
  ...overrides,
});

test('offline HTML validator accepts ordinary local DOM interaction', () => {
  assert.doesNotThrow(() => validate());
});

test('offline HTML validator rejects every navigation and resource attribute form', () => {
  for (const html of [
    '<a href=https://example.invalid>open</a>',
    '<a href="&#x68;ttps://example.invalid">open</a>',
    '<img src=data:image/png;base64,AA>',
    '<button formaction="/submit">submit</button>',
  ]) {
    assert.throws(() => validate({ html }), /navigation or resource URL attribute/);
  }
});

test('offline HTML validator rejects bracket navigation and dynamic code APIs', () => {
  for (const js of [
    "self['location'] = 'https://example.invalid'",
    "document.querySelector('a').href = 'https://example.invalid'",
    "new Function('return 1')()",
    "window.open('https://example.invalid')",
  ]) {
    assert.throws(() => validate({ js }), /network, storage, or cross-page API/);
  }
});
