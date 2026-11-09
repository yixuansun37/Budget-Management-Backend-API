// Opt in with MONGO_TEST_URI; only this suite's disposable database is removed.
jest.mock('../services/redisService', () => ({ get: jest.fn().mockResolvedValue(null) }));

const crypto = require('crypto');
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const Budget = require('../models/budget');
const User = require('../models/user');
const redis = require('../services/redisService');
const audit = require('../services/auditService');
const { generateToken } = require('../services/jwtService');

const app = express();
app.use(express.json());
app.use('/api/budget-requests', require('../routes/budgetRequestRoutes'));
app.use('/api/audit-trail', require('../routes/auditTrailRoutes'));
app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));

(process.env.MONGO_TEST_URI ? describe : describe.skip)('persistent budget audit trail with real MongoDB', () => {
  let employee, coworker, manager, otherManager, finance;
  const originalThreshold = process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD;
  const http = (user, method, path, body) => {
    const pending = request(app)[method](path);
    if (user) pending.auth(generateToken(String(user._id)), { type: 'bearer' });
    return body === undefined ? pending : pending.send(body);
  };
  const list = (user = finance, filters = {}) => {
    const pending = request(app).get('/api/audit-trail').query(filters);
    if (user) pending.auth(generateToken(String(user._id)), { type: 'bearer' });
    return pending;
  };
  const draft = async (owner = employee, overrides = {}) => {
    const response = await http(owner, 'post', '/api/budget-requests', {
      name: 'Travel audit request',
      limit: 250,
      assignedManager: String(manager._id),
      requestKey: crypto.randomUUID(),
      ...overrides,
    });
    expect(response.status).toBe(201);
    return response.body.request;
  };
  const transition = async (user, doc, action, body = {}, status = 200) => {
    const response = await http(user, 'post', `/api/budget-requests/${doc._id}/${action}`, { expectedVersion: doc.__v, ...body });
    expect(response.status).toBe(status);
    return response.body.request;
  };
  const records = async doc => {
    const response = await list(finance, { targetId: doc._id, pageSize: 100 });
    expect(response.status).toBe(200);
    return response.body.records;
  };

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_TEST_URI, { dbName: `audit_trail_test_${process.pid}` });
    [employee, coworker, manager, otherManager, finance] = await User.create(
      [
        ['employee', 'employee'],
        ['coworker', 'employee'],
        ['manager', 'manager'],
        ['other-manager', 'manager'],
        ['finance', 'finance_admin'],
      ].map(([username, role]) => ({
        username,
        role,
        email: `${username}@audit.example.test`,
        password: 'Audit-test-password-only',
      }))
    );
    await Budget.init();
  });
  beforeEach(async () => {
    process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD = '0';
    redis.get.mockResolvedValue(null);
    await Budget.deleteMany({});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (originalThreshold === undefined) delete process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD;
    else process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD = originalThreshold;
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test('persists creation and modification events with actor, target, time and safe before/after values', async () => {
    const created = await draft();
    const edited = await http(employee, 'patch', `/api/budget-requests/${created._id}`, {
      name: 'Updated travel',
      limit: 300,
      assignedManager: String(manager._id),
      expectedVersion: created.__v,
    });
    expect(edited.status).toBe(200);
    const events = await records(created);
    expect(events).toHaveLength(2);
    const creation = events.find(event => event.action === 'BUDGET_CREATED');
    expect(creation).toMatchObject({ actorId: String(employee._id), actorRole: 'employee', targetId: created._id, before: null });
    expect(creation.after).toMatchObject({ name: 'Travel audit request', limit: 250, approvalStatus: 'DRAFT' });
    const modification = events.find(event => event.action === 'BUDGET_MODIFIED');
    expect(modification.before).toMatchObject({ name: 'Travel audit request', limit: 250 });
    expect(modification.after).toMatchObject({ name: 'Updated travel', limit: 300 });
    for (const event of events) {
      expect(mongoose.isValidObjectId(event._id)).toBe(true);
      expect(Number.isFinite(Date.parse(event.timestamp))).toBe(true);
    }
    const persisted = await Budget.findById(created._id).select('+auditTrail').lean();
    expect(persisted.auditTrail).toHaveLength(2);
    expect((await Budget.findById(created._id).lean()).auditTrail).toBeUndefined();
  });

  test('records submission and each authorized approval stage atomically', async () => {
    const submitted = await transition(employee, await draft(), 'submit');
    const managed = await transition(manager, submitted, 'approve', { comment: 'Manager reviewed' });
    const financed = await transition(finance, managed, 'approve', { comment: 'Finance reviewed' });
    const final = await transition(finance, financed, 'finalize');
    const events = await records(final);
    expect(events.map(event => event.action).sort()).toEqual(['BUDGET_APPROVED', 'BUDGET_APPROVED', 'BUDGET_APPROVED', 'BUDGET_CREATED', 'BUDGET_SUBMITTED']);
    const submission = events.find(event => event.action === 'BUDGET_SUBMITTED');
    expect(submission).toMatchObject({ actorId: String(employee._id), before: { approvalStatus: 'DRAFT' }, after: { approvalStatus: 'SUBMITTED' } });
    expect(events.find(event => event.after?.approvalStatus === 'MANAGER_APPROVED')).toMatchObject({
      actorId: String(manager._id),
      before: { approvalStatus: 'SUBMITTED' },
    });
    expect(events.find(event => event.after?.approvalStatus === 'FINANCE_APPROVED')).toMatchObject({
      actorId: String(finance._id),
      before: { approvalStatus: 'MANAGER_APPROVED' },
    });
    expect(events.find(event => event.after?.approvalStatus === 'FINAL_APPROVED')).toMatchObject({
      actorId: String(finance._id),
      before: { approvalStatus: 'FINANCE_APPROVED' },
    });
    expect((await Budget.findById(final._id).select('+auditTrail')).auditTrail).toHaveLength(5);
  });

  test('records rejection while keeping arbitrary free text and secrets out of audit snapshots', async () => {
    const submitted = await transition(
      employee,
      await draft(employee, { password: 'do-not-copy', token: 'fake-jwt-secret', auditTrail: [{ action: 'FORGED' }] }),
      'submit'
    );
    const rejected = await transition(manager, submitted, 'reject', { comment: 'Do not log this arbitrary free-text reason: fake-jwt-secret' });
    const events = await records(rejected);
    const rejection = events.find(event => event.action === 'BUDGET_REJECTED');
    expect(rejection).toMatchObject({ actorId: String(manager._id), before: { approvalStatus: 'SUBMITTED' }, after: { approvalStatus: 'REJECTED' } });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('do-not-copy');
    expect(serialized).not.toContain('fake-jwt-secret');
    expect(serialized).not.toContain('FORGED');
    for (const event of events) {
      for (const snapshot of [event.before, event.after]) {
        if (!snapshot) continue;
        for (const field of ['password', 'token', 'jwt', 'requestKey', 'requestFingerprint', 'history', 'auditTrail', 'comment'])
          expect(snapshot[field]).toBeUndefined();
      }
    }
  });

  test('records policy-generated approval stages as system actions with ordered before/after states', async () => {
    process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD = '1000';
    const approved = await transition(manager, await transition(employee, await draft(), 'submit'), 'approve');
    const events = await records(approved);
    expect(events.filter(event => event.action === 'BUDGET_APPROVED')).toHaveLength(3);
    expect(events.find(event => event.after?.approvalStatus === 'FINANCE_APPROVED')).toMatchObject({
      actorId: null,
      actorRole: 'system',
      before: { approvalStatus: 'MANAGER_APPROVED' },
    });
    expect(events.find(event => event.after?.approvalStatus === 'FINAL_APPROVED')).toMatchObject({
      actorId: null,
      actorRole: 'system',
      before: { approvalStatus: 'FINANCE_APPROVED' },
    });
  });

  test('scopes audit access to own requests, assigned submitted requests, and finance oversight', async () => {
    const own = await draft();
    const other = await draft(coworker);
    expect((await list(employee)).body.records.map(event => event.targetId)).toEqual([own._id]);
    expect((await list(employee, { targetId: other._id })).body.records).toEqual([]);
    expect((await list(manager, { targetId: own._id })).body.records).toEqual([]);
    await transition(employee, own, 'submit');
    expect((await list(manager, { targetId: own._id })).body.records).toHaveLength(2);
    expect((await list(otherManager, { targetId: own._id })).body.records).toEqual([]);
    expect((await list(finance)).body.total).toBe(3);
  });

  test('requires an existing, nonrevoked account and current database authority', async () => {
    expect((await list(null)).status).toBe(401);
    expect((await request(app).get('/api/audit-trail').auth('invalid', { type: 'bearer' })).status).toBe(401);
    redis.get.mockResolvedValueOnce('true');
    expect((await list(employee)).status).toBe(401);
    await User.updateOne({ _id: finance._id }, { role: 'employee' });
    try {
      await draft();
      expect((await list(finance)).body.records).toEqual([]);
    } finally {
      await User.updateOne({ _id: finance._id }, { role: 'finance_admin' });
    }
  });

  test('has no audit creation, update or deletion route, even for finance admins', async () => {
    const created = await draft();
    const event = (await records(created))[0];
    for (const [method, path] of [
      ['post', '/api/audit-trail'],
      ['patch', `/api/audit-trail/${event._id}`],
      ['delete', `/api/audit-trail/${event._id}`],
    ]) {
      expect((await http(finance, method, path, { action: 'FORGED' })).status).toBe(404);
    }
    expect(await records(created)).toHaveLength(1);
  });

  test('draft edits cannot overwrite or inject previous audit records', async () => {
    const created = await draft();
    const first = (await records(created))[0];
    const response = await http(employee, 'patch', `/api/budget-requests/${created._id}`, {
      name: created.name,
      limit: 300,
      assignedManager: String(manager._id),
      expectedVersion: created.__v,
      auditTrail: [{ ...first, action: 'FORGED', before: null, after: null }],
    });
    expect(response.status).toBe(200);
    const events = await records(created);
    expect(events).toHaveLength(2);
    expect(events.find(event => event._id === first._id)).toEqual(first);
    expect(events.some(event => event.action === 'FORGED')).toBe(false);
  });

  test('paginates deterministically without duplicating or losing records across pages', async () => {
    const doc = await transition(employee, await draft(), 'submit');
    await transition(manager, doc, 'approve');
    const first = await list(finance, { page: 1, pageSize: 2 });
    const second = await list(finance, { page: 2, pageSize: 2 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    expect(first.body.records).toHaveLength(2);
    expect(second.body.records).toHaveLength(1);
    expect(new Set([...first.body.records, ...second.body.records].map(event => event._id)).size).toBe(3);
    expect((await list(finance, { page: 1, pageSize: 2 })).body.records.map(event => event._id)).toEqual(first.body.records.map(event => event._id));
    expect((await list(finance, { page: 10, pageSize: 2 })).body.records).toEqual([]);
  });

  test('filters by target, action and inclusive UTC calendar dates', async () => {
    const created = await draft();
    const submitted = await transition(employee, created, 'submit');
    const raw = await Budget.findById(created._id).select('+auditTrail').lean();
    raw.auditTrail[0].timestamp = new Date('2024-02-01T00:00:00.000Z');
    raw.auditTrail[1].timestamp = new Date('2024-02-29T23:59:59.999Z');
    await Budget.collection.updateOne({ _id: raw._id }, { $set: { auditTrail: raw.auditTrail } });
    const month = await list(finance, { targetId: submitted._id, from: '2024-02-01', to: '2024-02-29' });
    expect(month.body.total).toBe(2);
    const lastDay = await list(finance, { from: '2024-02-29', to: '2024-02-29', action: 'BUDGET_SUBMITTED' });
    expect(lastDay.body.records).toHaveLength(1);
    expect(lastDay.body.records[0].targetId).toBe(submitted._id);
    expect((await list(finance, { from: '2024-03-01' })).body.records).toEqual([]);
  });

  test.each([
    { targetId: 'invalid' },
    { 'targetId[$ne]': 'x' },
    { action: 'FORGED' },
    { 'action[$ne]': 'x' },
    { from: '2024-02-30' },
    { to: 'not-a-date' },
    { from: '2024-03-01', to: '2024-02-01' },
    { page: 0 },
    { page: -1 },
    { page: '1.5' },
    { page: 'abc' },
    { pageSize: 0 },
    { pageSize: 101 },
  ])('rejects malformed audit filters %j', async filters => {
    expect((await list(finance, filters)).status).toBe(400);
  });

  test('does not add audit events for idempotent creation retries or failed transitions', async () => {
    const key = crypto.randomUUID();
    const created = await draft(employee, { requestKey: key });
    const duplicate = await http(employee, 'post', '/api/budget-requests', {
      name: created.name,
      limit: created.limit,
      assignedManager: String(manager._id),
      requestKey: key,
    });
    expect(duplicate.status).toBe(200);
    expect(await records(created)).toHaveLength(1);
    const submitted = await transition(employee, created, 'submit');
    await transition(employee, submitted, 'submit', {}, 409);
    await transition(manager, submitted, 'reject', { comment: ' ' }, 400);
    expect(await records(created)).toHaveLength(2);
    const responses = await Promise.all([
      http(manager, 'post', `/api/budget-requests/${created._id}/approve`, { expectedVersion: submitted.__v }),
      http(manager, 'post', `/api/budget-requests/${created._id}/approve`, { expectedVersion: submitted.__v }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await records(created)).toHaveLength(3);
  });

  test('a failed atomic write leaves both business state and persisted audit history unchanged', async () => {
    const created = await draft();
    const before = await Budget.findById(created._id).select('+auditTrail').lean();
    jest.spyOn(Budget, 'findOneAndUpdate').mockImplementationOnce(() => {
      throw new Error('Simulated persistence failure');
    });
    expect((await http(employee, 'post', `/api/budget-requests/${created._id}/submit`, { expectedVersion: created.__v })).status).toBe(500);
    const after = await Budget.findById(created._id).select('+auditTrail').lean();
    expect(after.approvalStatus).toBe(before.approvalStatus);
    expect(after.__v).toBe(before.__v);
    expect(after.auditTrail).toEqual(before.auditTrail);
  });

  test('invalid audit evidence prevents the associated transition from committing', async () => {
    const created = await draft();
    const makeEvent = audit.event;
    jest.spyOn(audit, 'event').mockImplementationOnce((action, ...args) => makeEvent('INVALID_AUDIT_ACTION', ...args));
    expect((await http(employee, 'post', `/api/budget-requests/${created._id}/submit`, { expectedVersion: created.__v })).status).toBe(500);
    const persisted = await Budget.findById(created._id).select('+auditTrail').lean();
    expect(persisted.approvalStatus).toBe('DRAFT');
    expect(persisted.__v).toBe(created.__v);
    expect(persisted.auditTrail).toHaveLength(1);
  });

  test('invalid creation audit evidence prevents creating the business record', async () => {
    const makeEvent = audit.event;
    jest.spyOn(audit, 'event').mockImplementationOnce((action, ...args) => makeEvent('INVALID_AUDIT_ACTION', ...args));
    const response = await http(employee, 'post', '/api/budget-requests', {
      name: 'Must not persist',
      limit: 250,
      assignedManager: String(manager._id),
      requestKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(500);
    expect(await Budget.countDocuments()).toBe(0);
  });

  test('audit read failures report errors rather than empty success', async () => {
    await draft();
    jest.spyOn(Budget, 'aggregate').mockRejectedValueOnce(new Error('Simulated audit read failure'));
    expect((await list(finance)).status).toBe(500);
  });
});
