'use strict';

const path = require('node:path');

// The patch script contains a TypeScript template literal inside a JavaScript
// template literal. Inject the literal placeholder so Node does not try to
// resolve the target application's NOTE_SERVER_URL while constructing source.
globalThis.NOTE_SERVER_URL = '${NOTE_SERVER_URL}';
require(path.join(__dirname, 'apply-learning-center-image-display-fix.cjs'));
