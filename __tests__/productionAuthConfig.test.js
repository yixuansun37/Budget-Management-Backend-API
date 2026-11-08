const originalMode = process.env.NODE_ENV;
const originalSecret = process.env.JWT_SECRET;
afterEach(() => {
  process.env.NODE_ENV = originalMode;
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
  jest.resetModules();
});
test.each([undefined, 'dev-secret-change-me'])('production rejects an absent/default signing secret', value => {
  process.env.NODE_ENV = 'production';
  if (value === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = value;
  jest.isolateModules(() => expect(() => require('../config/config')).toThrow('JWT_SECRET is required'));
});
test('production accepts an explicitly configured signing secret', () => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'production-config-unit-test-only';
  jest.isolateModules(() => expect(() => require('../config/config')).not.toThrow());
});
