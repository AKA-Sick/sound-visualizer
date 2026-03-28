import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const addon = require('../src/native/build/Release/audio_capture.node');
console.log(addon.hello());
