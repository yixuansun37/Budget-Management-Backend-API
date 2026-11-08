// src/jest.config.js
module.exports = {
  // point back at your frontend/ folder, not src/
  rootDir: '..',

  // run in a browser-like env so React + MUI work
  testEnvironment: 'jsdom',

  // load your jest-dom matchers
  setupFilesAfterEnv: ['<rootDir>/src/jest.setup.js'],

  // transform every .js/.jsx through babel-jest
  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', { configFile: require.resolve('./babel.config.js') }],
  },

  // extensions to look for
  moduleFileExtensions: ['js', 'jsx', 'json'],

  // Jest 27 predates React Router 7's package exports; select its CommonJS builds.
  moduleNameMapper: {
    '^axios$': '<rootDir>/node_modules/axios/dist/browser/axios.cjs',
    '^react-router-dom$': '<rootDir>/node_modules/react-router-dom/dist/index.js',
    '^react-router$': '<rootDir>/node_modules/react-router/dist/development/index.js',
    '^react-router/dom$': '<rootDir>/node_modules/react-router/dist/development/dom-export.js',
  },

  // ignore the nested package.json that haste complains about
  modulePathIgnorePatterns: ['<rootDir>/frontend/package.json'],
};
