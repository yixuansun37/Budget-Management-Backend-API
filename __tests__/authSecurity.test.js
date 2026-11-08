jest.mock('../models/user', () => {
  const User = jest.fn();
  User.findOne = jest.fn();
  User.findByIdAndUpdate = jest.fn();
  return User;
});
jest.mock('../services/redisService', () => ({ get: jest.fn(), set: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const User = require('../models/user');
const redisClient = require('../services/redisService');
const authenticate = require('../middleware/authMiddleware');
const auth = require('../controllers/authController');
const users = require('../controllers/userController');
const { generateToken, tokenBlacklistKey } = require('../services/jwtService');

const app = express();
app.use(express.json());
app.get('/protected', authenticate, (req, res) => res.json({ userId: req.user.userId }));
app.post('/logout', authenticate, auth.logout);
app.post('/verify-token', auth.verifyToken);
app.post('/reset-password', auth.resetPassword);
app.post('/register', auth.register);
app.patch('/profile', authenticate, users.patchProfile);
app.put('/profile', authenticate, users.updateProfile);
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
const userId = '665500000000000000000001';
let revoked;

beforeEach(() => {
  jest.clearAllMocks();
  revoked = new Map();
  redisClient.get.mockImplementation(async key => revoked.get(key));
  redisClient.set.mockImplementation(async (key, value) => revoked.set(key, value));
  User.findByIdAndUpdate.mockReturnValue({ select: jest.fn().mockResolvedValue({ _id: userId, username: 'updated' }) });
});

const signed = (method, path, body, token = generateToken(userId)) => request(app)[method](path).auth(token, { type: 'bearer' }).send(body);

test('revocation uses userId and a hash of the bearer token', async () => {
  const token = generateToken(userId);
  const response = await signed('get', '/protected', undefined, token);
  expect(response.status).toBe(200);
  const key = tokenBlacklistKey(token, userId);
  expect(redisClient.get).toHaveBeenCalledWith(key);
  expect(key).toMatch(/^blacklist:665500000000000000000001:[a-f0-9]{64}$/);
  expect(key).not.toContain(token);
  revoked.set(key, 'true');
  expect((await signed('get', '/protected', undefined, token)).status).toBe(401);
});

test('logout ignores another user supplied by body and revokes only the current session', async () => {
  const token = generateToken(userId);
  const nextToken = generateToken(userId);
  expect(nextToken).not.toBe(token);
  const response = await signed('post', '/logout', { email: 'other@example.test', userId: 'someone-else' }, token);
  expect(response.status).toBe(200);
  expect(redisClient.set).toHaveBeenCalledWith(tokenBlacklistKey(token, userId), 'true', { EX: expect.any(Number) });
  const ttl = redisClient.set.mock.calls[0][2].EX;
  expect(ttl).toBeGreaterThan(172790);
  expect(ttl).toBeLessThanOrEqual(172800);
  expect(User.findOne).not.toHaveBeenCalled();
  expect((await signed('get', '/protected', undefined, token)).status).toBe(401);
  expect((await signed('get', '/protected', undefined, nextToken)).status).toBe(200);
});

test('logout works without a request body', async () => {
  expect((await signed('post', '/logout')).status).toBe(200);
});

test('verify-token uses the configured JWT secret and current token revocation', async () => {
  const token = generateToken(userId);
  expect((await request(app).post('/verify-token').send({ token })).body).toEqual({ valid: true });
  revoked.set(tokenBlacklistKey(token, userId), 'true');
  expect((await request(app).post('/verify-token').send({ token })).status).toBe(401);
  expect((await request(app).post('/verify-token').send({ token: 'invalid' })).status).toBe(401);
  expect((await request(app).post('/verify-token')).status).toBe(400);
});

test.each([{ userId: { $ne: null } }, { userId: '' }, { userId: ' ' }, { id: userId }])('rejects malformed signed JWT identity %j', async payload => {
  const token = jwt.sign(payload, config.jwtSecret, { expiresIn: '48h' });
  expect((await signed('get', '/protected', undefined, token)).status).toBe(401);
  expect((await request(app).post('/verify-token').send({ token })).status).toBe(401);
});

test('requires an expiring bearer token and correct authorization scheme', async () => {
  const nonExpiring = jwt.sign({ userId }, config.jwtSecret);
  expect((await signed('get', '/protected', undefined, nonExpiring)).status).toBe(401);
  expect(
    (
      await request(app)
        .get('/protected')
        .set('Authorization', 'Basic ' + generateToken(userId))
    ).status
  ).toBe(401);
});

test.each([
  { role: 'finance_admin' },
  { manager: userId },
  { password: 'plaintext' },
  { username: 'new', role: 'manager' },
  { $set: { role: 'finance_admin' } },
  {},
  { username: {} },
])('rejects profile privilege or invalid-field mutation %j', async body => {
  for (const method of ['patch', 'put']) {
    expect((await signed(method, '/profile', body)).status).toBe(400);
  }
  expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
});

test('permits ordinary profile changes for the authenticated user only', async () => {
  expect((await signed('patch', '/profile', { username: 'updated' })).status).toBe(200);
  expect(User.findByIdAndUpdate).toHaveBeenCalledWith(userId, { username: 'updated' }, { new: true, runValidators: true });
  expect((await signed('put', '/profile', { username: 'updated', email: 'user@example.test' })).status).toBe(200);
});

test('public password reset is disabled rather than changing a privileged password without proof', async () => {
  const response = await request(app).post('/reset-password').send({ email: 'admin@example.test', newPassword: 'attacker-password' });
  expect(response.status).toBe(501);
  expect(response.body.error).toMatch(/not configured/);
  expect(User.findOne).not.toHaveBeenCalled();
});

test('registration ignores role and manager fields supplied by the caller', async () => {
  User.findOne.mockResolvedValue(null);
  User.mockImplementation(() => ({ _id: userId, save: jest.fn().mockResolvedValue(undefined) }));
  const response = await request(app)
    .post('/register')
    .send({ username: 'new', email: 'new@example.test', password: 'secure-password', role: 'finance_admin', manager: userId });
  expect(response.status).toBe(201);
  expect(User).toHaveBeenCalledWith({ username: 'new', email: 'new@example.test', password: 'secure-password' });
});
