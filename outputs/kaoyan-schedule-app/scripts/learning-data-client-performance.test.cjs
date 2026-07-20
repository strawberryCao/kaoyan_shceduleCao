const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-learning-client-test-'));
const bundledModulePath = path.join(tempDirectory, 'learning-data.cjs');

buildSync({
  entryPoints: [path.resolve(__dirname, '../src/utils/learningData.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundledModulePath,
  logLevel: 'silent',
});

const storedValues = new Map();
let storageWrites = 0;
let dispatchedEvents = 0;
let eventSourcesCreated = 0;
let eventSourcesClosed = 0;
let intervalsCreated = 0;
let intervalsCleared = 0;
let fetches = 0;

class FakeEventSource {
  constructor() {
    eventSourcesCreated += 1;
  }

  addEventListener() {}

  close() {
    eventSourcesClosed += 1;
  }
}

class FakeCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
}

global.EventSource = FakeEventSource;
global.CustomEvent = FakeCustomEvent;
global.fetch = async () => {
  fetches += 1;
  return {
    ok: true,
    json: async () => ({ version: 1, revision: 7, updatedAt: '2026-07-18T12:00:00.000Z', days: {}, cards: [] }),
  };
};
global.window = {
  EventSource: FakeEventSource,
  location: { hostname: 'localhost' },
  localStorage: {
    getItem: (key) => storedValues.get(key) ?? null,
    setItem: (key, value) => {
      storageWrites += 1;
      storedValues.set(key, value);
    },
  },
  dispatchEvent: () => {
    dispatchedEvents += 1;
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  setTimeout,
  clearTimeout,
  setInterval: () => {
    intervalsCreated += 1;
    return intervalsCreated;
  },
  clearInterval: () => {
    intervalsCleared += 1;
  },
};

const learningData = require(bundledModulePath);

test.after(() => {
  fs.unlinkSync(bundledModulePath);
  fs.rmdirSync(tempDirectory);
});

test('does not rewrite and redispatch an identical learning snapshot', () => {
  const snapshot = {
    version: 1,
    revision: 1,
    updatedAt: '2026-07-18T09:00:00.000Z',
    days: {},
    cards: [],
  };

  learningData.saveLearningDataCache(snapshot);
  learningData.saveLearningDataCache(snapshot);

  assert.equal(storageWrites, 1);
  assert.equal(dispatchedEvents, 1);

  learningData.saveLearningDataCache({
    ...snapshot,
    revision: 2,
    updatedAt: '2026-07-18T09:01:00.000Z',
  });
  assert.equal(storageWrites, 2);
  assert.equal(dispatchedEvents, 2);
});

test('client normalization keeps an explicit manual default classification', () => {
  const snapshot = learningData.normalizeLearningData({
    version: 1,
    revision: 3,
    days: {
      '2026-07-17': {
        manual: {},
        autoNotes: [{
          noteUid: 'manual-default',
          capturedDate: '2026-07-17',
          subject: '默认文件夹',
          knowledgePath: ['默认文件夹', '图像噪声'],
          filePath: 'C:\\Users\\ASUS\\Desktop\\笔记\\计算机视觉\\图像.png',
          classificationSource: 'manual',
          organizationStatus: 'confirmed',
        }],
      },
    },
    cards: [],
  });
  const note = snapshot.days['2026-07-17'].autoNotes[0];
  assert.equal(note.subject, '默认文件夹');
  assert.deepEqual(note.knowledgePath, ['默认文件夹', '图像噪声']);
});

test('shares realtime and fallback polling resources until the last subscriber leaves', async () => {
  const releaseRealtimeA = learningData.subscribeLearningDataFromServer();
  const releaseRealtimeB = learningData.subscribeLearningDataFromServer();
  assert.equal(eventSourcesCreated, 1);

  releaseRealtimeA();
  assert.equal(eventSourcesClosed, 0);
  releaseRealtimeB();
  releaseRealtimeB();
  assert.equal(eventSourcesClosed, 1);

  const releasePollingA = learningData.subscribeLearningDataPolling();
  const releasePollingB = learningData.subscribeLearningDataPolling();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(intervalsCreated, 1);
  assert.equal(fetches, 1);

  releasePollingA();
  assert.equal(intervalsCleared, 0);
  releasePollingB();
  releasePollingB();
  assert.equal(intervalsCleared, 1);
});
