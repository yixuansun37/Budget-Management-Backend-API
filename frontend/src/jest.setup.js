require('@testing-library/jest-dom');
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;
// jsdom has no viewport observer; layout tests do not exercise scroll animations.
global.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
