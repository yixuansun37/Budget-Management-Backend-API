// Opt in with MONGO_TEST_URI. Only this suite's disposable database is dropped.
jest.mock('../services/redisService', () => ({ get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() }));
jest.mock('../apache-kafka/kafkaService', () => ({ publishEvent: jest.fn() }));
jest.mock('../services/auditService', () => {
  const actual = jest.requireActual('../services/auditService');
  return { ...actual, event: jest.fn(actual.event) };
});
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const grpc = require('@grpc/grpc-js');
const Budget = require('../models/budget');
const Expense = require('../models/expense');
const User = require('../models/user');
const audit = require('../services/auditService');
const redis = require('../services/redisService');
const { publishEvent } = require('../apache-kafka/kafkaService');
const { generateToken } = require('../services/jwtService');
const handlers = require('../grpcServer').handlers;
const app = express();
app.use(express.json());
app.use('/api/budgets', require('../routes/budgetRoutes'));
app.use((err, req, res, next) => res.status(err.name === 'ValidationError' ? 400 : 500).json({ error: 'Business write failed' }));

(process.env.MONGO_TEST_URI ? describe : describe.skip)('legacy budget audit atomicity and persistence', () => {
  let finance, employee;
  const http = (method, path = '', body, user = finance) =>
    request(app)
      [method]('/api/budgets' + path)
      .auth(generateToken(String(user._id)), { type: 'bearer' })
      .send(body);
  const rpc = (method, body, user = finance) =>
    new Promise(resolve => {
      const metadata = new grpc.Metadata();
      metadata.set('authorization', 'Bearer ' + generateToken(String(user._id)));
      handlers[method]({ metadata, request: body }, (error, data) => resolve({ error, data }));
    });
  const read = id => Budget.findById(id).select('+auditTrail').lean();
  const create = async () => {
    const response = await http('post', '', { name: 'Legacy audited', limit: 100 });
    expect(response.status).toBe(201);
    return response.body.budget;
  };
  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_TEST_URI, { dbName: `legacy_audit_test_${process.pid}` });
    [finance, employee] = await User.create([
      { username: 'audit-finance', email: 'finance@audit.test', password: 'Test-only-password', role: 'finance_admin' },
      { username: 'audit-employee', email: 'employee@audit.test', password: 'Test-only-password', role: 'employee' },
    ]);
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    audit.event.mockImplementation(jest.requireActual('../services/auditService').event);
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    publishEvent.mockResolvedValue(null);
    await Budget.deleteMany({});
    await Expense.deleteMany({});
  });
  afterAll(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test('REST creation and modification persist allowlisted audit snapshots in the same record', async () => {
    const response = await http('post', '', { name: 'Legacy audited', limit: 100, password: 'secret-marker', token: 'secret-marker', auditTrail: [] });
    expect(response.status).toBe(201);
    expect(response.body.budget.auditTrail).toBeUndefined();
    const id = response.body.budget._id;
    const created = await read(id);
    expect(created.auditTrail).toHaveLength(1);
    expect(created.auditTrail[0]).toMatchObject({ action: 'BUDGET_CREATED', actorId: finance._id, targetId: created._id, before: null });
    expect(created.auditTrail[0].after).toMatchObject({ name: 'Legacy audited', limit: 100 });
    expect(Number.isFinite(new Date(created.auditTrail[0].timestamp).getTime())).toBe(true);
    expect((await http('put', '/' + id, { name: 'Modified audited', limit: 120, jwt: 'secret-marker', auditTrail: [] })).status).toBe(200);
    const modified = await read(id);
    expect(modified.auditTrail).toHaveLength(2);
    expect(modified.auditTrail[1]).toMatchObject({
      action: 'BUDGET_MODIFIED',
      before: { name: 'Legacy audited', limit: 100 },
      after: { name: 'Modified audited', limit: 120 },
    });
    expect(JSON.stringify(modified.auditTrail)).not.toContain('secret-marker');
    expect((await http('get', '/' + id, undefined, employee)).body.budget.auditTrail).toBeUndefined();
  });

  test('REST deletion retains audit and expenses while hiding the soft-deleted budget', async () => {
    const created = await create();
    await Expense.create({ budgetId: created._id, description: 'Preserved financial reference', amount: 5 });
    expect((await http('delete', '/' + created._id)).status).toBe(200);
    const stored = await read(created._id);
    expect(stored.deletedAt).toBeInstanceOf(Date);
    expect(stored.auditTrail.map(entry => entry.action)).toEqual(['BUDGET_CREATED', 'BUDGET_DELETED']);
    expect(stored.auditTrail[1].after.deletedAt).toBeTruthy();
    expect(await Expense.countDocuments({ budgetId: created._id })).toBe(1);
    expect((await http('get', '/' + created._id, undefined, employee)).status).toBe(404);
    expect((await http('get')).body).toEqual([]);
    expect((await http('delete', '/' + created._id)).status).toBe(404);
    expect((await http('put', '/' + created._id, { limit: 2 })).status).toBe(404);
    expect((await read(created._id)).auditTrail).toHaveLength(2);
  });

  test('audit construction failures prevent creation and modification', async () => {
    audit.event.mockImplementationOnce(() => {
      throw new Error('Audit unavailable');
    });
    expect((await http('post', '', { name: 'Never committed', limit: 100 })).status).toBe(500);
    expect(await Budget.countDocuments()).toBe(0);
    const created = await create();
    audit.event.mockImplementationOnce(() => {
      throw new Error('Audit unavailable');
    });
    expect((await http('put', '/' + created._id, { limit: 999 })).status).toBe(500);
    const stored = await read(created._id);
    expect(stored.limit).toBe(100);
    expect(stored.auditTrail).toHaveLength(1);
  });

  test('database mutation failures leave both business state and audit unchanged', async () => {
    const created = await create();
    jest.spyOn(Budget, 'findOneAndUpdate').mockRejectedValueOnce(new Error('Write rejected'));
    expect((await http('put', '/' + created._id, { limit: 999 })).status).toBe(500);
    const stored = await read(created._id);
    expect(stored.limit).toBe(100);
    expect(stored.auditTrail).toHaveLength(1);
  });

  test('audit validation rejects the complete create/update/delete write atomically', async () => {
    audit.event.mockReturnValueOnce({});
    expect((await http('post', '', { name: 'Invalid audit', limit: 100 })).status).toBe(400);
    expect(await Budget.countDocuments()).toBe(0);
    const created = await create();
    audit.event.mockReturnValueOnce({});
    expect((await http('put', '/' + created._id, { limit: 999 })).status).toBe(400);
    audit.event.mockReturnValueOnce({});
    expect((await http('delete', '/' + created._id)).status).toBe(400);
    const stored = await read(created._id);
    expect(stored.limit).toBe(100);
    expect(stored.deletedAt).toBeUndefined();
    expect(stored.auditTrail).toHaveLength(1);
  });

  test('cache and event delivery failures do not turn committed audited writes into reported failures', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    redis.set.mockRejectedValue(new Error('Cache offline'));
    redis.del.mockRejectedValue(new Error('Cache offline'));
    publishEvent.mockRejectedValue(new Error('Broker offline'));
    const created = await create();
    expect((await http('put', '/' + created._id, { limit: 120 })).status).toBe(200);
    expect((await http('delete', '/' + created._id)).status).toBe(200);
    expect((await read(created._id)).auditTrail.map(entry => entry.action)).toEqual(['BUDGET_CREATED', 'BUDGET_MODIFIED', 'BUDGET_DELETED']);
    expect(warning).toHaveBeenCalled();
  });

  test('gRPC legacy CRUD appends actor-attributed audit events and preserves the tombstone', async () => {
    const created = await rpc('CreateBudget', { name: 'gRPC audit', limit: 10 });
    expect(created.error).toBeNull();
    const id = created.data.budgetId;
    expect((await rpc('UpdateBudget', { budgetId: id, name: 'gRPC changed', limit: 11 })).error).toBeNull();
    expect((await rpc('DeleteBudget', { budgetId: id })).data.deleted).toBe(true);
    const stored = await read(id);
    expect(stored.auditTrail.map(entry => entry.action)).toEqual(['BUDGET_CREATED', 'BUDGET_MODIFIED', 'BUDGET_DELETED']);
    for (const entry of stored.auditTrail) expect(String(entry.actorId)).toBe(String(finance._id));
    expect((await rpc('GetBudget', { budgetId: id })).error).toBeTruthy();
    expect((await rpc('UpdateBudget', { budgetId: id, limit: 20 })).error).toBeTruthy();
    expect((await read(id)).auditTrail).toHaveLength(3);
  });
});
