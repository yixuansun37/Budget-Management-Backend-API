// Opt in with MONGO_TEST_URI. Tests use and drop only their own disposable database.
jest.mock('../services/redisService', () => ({ get: jest.fn().mockResolvedValue(null) }));

const crypto = require('crypto');
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const Budget = require('../models/budget');
const User = require('../models/user');
const redis = require('../services/redisService');
const { generateToken } = require('../services/jwtService');

const app = express();
app.use(express.json());
app.use('/api/budget-requests', require('../routes/budgetRequestRoutes'));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

(process.env.MONGO_TEST_URI ? describe : describe.skip)('budget approvals and RBAC with real MongoDB', () => {
  let employee, coworker, manager, otherManager, finance;
  const initialThreshold = process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD;
  const call = (user, method, path = '', body) => {
    const pending = request(app)[method](`/api/budget-requests${path}`);
    if (user) pending.auth(generateToken(user._id), { type: 'bearer' });
    return body === undefined ? pending : pending.send(body);
  };
  const createDraft = async (owner = employee, overrides = {}) => {
    const response = await call(owner, 'post', '', {
      name: 'Travel request',
      limit: 250,
      assignedManager: String(manager._id),
      requestKey: crypto.randomUUID(),
      ...overrides,
    });
    expect(response.status).toBe(201);
    return response.body.request;
  };
  const act = (user, doc, action, extra = {}) => call(user, 'post', `/${doc._id}/${action}`, { expectedVersion: doc.__v, ...extra });
  const submit = async doc => {
    const response = await act(employee, doc, 'submit');
    expect(response.status).toBe(200);
    return response.body.request;
  };

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_TEST_URI, { dbName: `budget_approval_test_${process.pid}` });
    const people = [
      ['employee', 'employee'],
      ['coworker', 'employee'],
      ['manager', 'manager'],
      ['otherManager', 'manager'],
      ['finance', 'finance_admin'],
    ];
    [employee, coworker, manager, otherManager, finance] = await User.create(
      people.map(([username, role]) => ({
        username,
        email: `${username}@example.test`,
        password: 'Integration-only-password',
        role,
      }))
    );
    await Budget.init();
  });
  beforeEach(async () => {
    process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD = '0';
    redis.get.mockResolvedValue(null);
    await Budget.deleteMany({});
  });
  afterAll(async () => {
    if (initialThreshold === undefined) delete process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD;
    else process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD = initialThreshold;
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test('requires a valid JWT and honors user revocation', async () => {
    expect((await call(null, 'get')).status).toBe(401);
    expect((await request(app).get('/api/budget-requests').auth('invalid', { type: 'bearer' })).status).toBe(401);
    redis.get.mockResolvedValueOnce('true');
    expect((await call(employee, 'get')).status).toBe(401);
  });

  test('only employees create drafts, and cannot inject requester, status or history', async () => {
    expect((await call(manager, 'post', '', {})).status).toBe(403);
    expect((await call(finance, 'post', '', {})).status).toBe(403);
    const doc = await createDraft(employee, { requester: String(coworker._id), approvalStatus: 'FINAL_APPROVED', history: [] });
    expect(String(doc.requester)).toBe(String(employee._id));
    expect(doc.approvalStatus).toBe('DRAFT');
    expect(doc.history.map(event => event.status)).toEqual(['DRAFT']);
  });

  test.each([0, -1, '250', null])('rejects invalid amount %j', async limit => {
    const response = await call(employee, 'post', '', { name: 'Invalid', limit, assignedManager: String(manager._id), requestKey: crypto.randomUUID() });
    expect(response.status).toBe(400);
  });

  test('requires a real assigned manager and an idempotency key', async () => {
    const body = { name: 'Travel', limit: 20, assignedManager: String(coworker._id), requestKey: crypto.randomUUID() };
    expect((await call(employee, 'post', '', body)).status).toBe(400);
    expect((await call(employee, 'post', '', { ...body, assignedManager: String(manager._id), requestKey: undefined })).status).toBe(400);
  });

  test('retries create idempotently and rejects changed payloads under the same key', async () => {
    const body = { name: 'Travel', limit: 250, assignedManager: String(manager._id), requestKey: crypto.randomUUID() };
    const first = await call(employee, 'post', '', body);
    const retry = await call(employee, 'post', '', body);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.request._id).toBe(first.body.request._id);
    expect(await Budget.countDocuments()).toBe(1);
    expect((await call(employee, 'post', '', { ...body, limit: 999 })).status).toBe(409);
  });

  test('concurrent duplicate creates produce one request', async () => {
    const body = { name: 'Concurrent', limit: 250, assignedManager: String(manager._id), requestKey: crypto.randomUUID() };
    const responses = await Promise.all([call(employee, 'post', '', body), call(employee, 'post', '', body)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    expect(responses[0].body.request._id).toBe(responses[1].body.request._id);
    expect(await Budget.countDocuments()).toBe(1);
  });

  test('employees can only list and change their own requests', async () => {
    const own = await createDraft();
    await createDraft(coworker);
    const list = await call(employee, 'get', '?view=mine');
    expect(list.status).toBe(200);
    expect(list.body.requests.map(doc => doc._id)).toEqual([own._id]);
    const denied = await call(coworker, 'patch', `/${own._id}`, { name: 'Stolen', expectedVersion: own.__v });
    expect([403, 404]).toContain(denied.status);
    expect([403, 404]).toContain((await act(coworker, own, 'submit')).status);
  });

  test('allows editing a draft but freezes its amount and assignment after submission', async () => {
    const draft = await createDraft();
    const edited = await call(employee, 'patch', `/${draft._id}`, {
      name: 'Updated travel',
      limit: 300,
      assignedManager: String(otherManager._id),
      expectedVersion: draft.__v,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.request).toMatchObject({ name: 'Updated travel', limit: 300, assignedManager: String(otherManager._id) });
    const submitted = await submit(edited.body.request);
    expect((await call(employee, 'patch', `/${draft._id}`, { limit: 999, expectedVersion: submitted.__v })).status).toBe(409);
  });

  test('requires a version and rejects repeated submission', async () => {
    const draft = await createDraft();
    expect((await call(employee, 'post', `/${draft._id}/submit`, {})).status).toBe(400);
    const submitted = await submit(draft);
    expect(submitted.approvalStatus).toBe('SUBMITTED');
    expect((await act(employee, submitted, 'submit')).status).toBe(409);
  });

  test('rejects guessed future versions without changing state or history', async () => {
    const draft = await createDraft();
    expect((await act(employee, draft, 'submit', { expectedVersion: draft.__v + 1 })).status).toBe(409);
    const stored = await Budget.findById(draft._id).lean();
    expect(stored.approvalStatus).toBe('DRAFT');
    expect(stored.__v).toBe(draft.__v);
    expect(stored.history.map(event => event.status)).toEqual(['DRAFT']);
  });

  test.each(['-1', 'not-a-number', '', '0.001'])('fails closed on invalid threshold configuration %j', async threshold => {
    const draft = await createDraft();
    process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD = threshold;
    const response = await act(employee, draft, 'submit');
    expect(response.status).toBe(503);
    expect((await Budget.findById(draft._id).lean()).approvalStatus).toBe('DRAFT');
  });

  test('revalidates the assigned manager role when submitting a saved draft', async () => {
    const draft = await createDraft();
    await User.updateOne({ _id: manager._id }, { role: 'employee' });
    try {
      expect((await act(employee, draft, 'submit')).status).toBe(400);
      expect((await Budget.findById(draft._id).lean()).approvalStatus).toBe('DRAFT');
    } finally {
      await User.updateOne({ _id: manager._id }, { role: 'manager' });
    }
  });

  test('enforces manager assignment, role permissions, and finance stage order', async () => {
    const submitted = await submit(await createDraft());
    expect([403, 404]).toContain((await act(otherManager, submitted, 'approve')).status);
    expect((await act(employee, submitted, 'approve')).status).toBe(403);
    expect((await act(finance, submitted, 'approve')).status).toBe(409);
    expect((await act(finance, submitted, 'finalize')).status).toBe(409);
    const pending = await call(manager, 'get', '?view=pending');
    expect(pending.body.requests.map(doc => doc._id)).toEqual([submitted._id]);
    expect((await call(otherManager, 'get', '?view=pending')).body.requests).toEqual([]);
  });

  test('keeps draft details private and restricts the pending review inbox to reviewers', async () => {
    const own = await createDraft();
    const other = await createDraft(coworker);
    expect((await call(manager, 'get', `/${own._id}`)).status).toBe(404);
    expect((await call(coworker, 'get', `/${own._id}`)).status).toBe(404);
    expect((await call(employee, 'get', '?view=pending')).status).toBe(403);
    const history = await call(finance, 'get', '?view=history');
    expect(history.status).toBe(200);
    expect(history.body.requests.map(doc => doc._id).sort()).toEqual([own._id, other._id].sort());
    expect((await call(finance, 'get', `/${own._id}`)).status).toBe(200);
  });

  test('finance pending inbox follows manager and finance review stages', async () => {
    const submitted = await submit(await createDraft());
    expect((await call(finance, 'get', '?view=pending')).body.requests).toEqual([]);
    const managed = (await act(manager, submitted, 'approve')).body.request;
    expect((await call(finance, 'get', '?view=pending')).body.requests.map(doc => doc._id)).toEqual([managed._id]);
    const financed = (await act(finance, managed, 'approve')).body.request;
    expect((await call(finance, 'get', '?view=pending')).body.requests.map(doc => doc._id)).toEqual([financed._id]);
    expect((await act(finance, financed, 'finalize')).status).toBe(200);
    expect((await call(finance, 'get', '?view=pending')).body.requests).toEqual([]);
  });

  test('records the full authorized multi-level lifecycle with approvers, timestamps and comments', async () => {
    const submitted = await submit(await createDraft());
    const managed = await act(manager, submitted, 'approve', { comment: 'Manager reviewed' });
    expect(managed.status).toBe(200);
    expect(managed.body.request.approvalStatus).toBe('MANAGER_APPROVED');
    const financed = await act(finance, managed.body.request, 'approve', { comment: 'Finance reviewed' });
    expect(financed.status).toBe(200);
    expect(financed.body.request.approvalStatus).toBe('FINANCE_APPROVED');
    const final = await act(finance, financed.body.request, 'finalize', { comment: 'Released' });
    expect(final.status).toBe(200);
    expect(final.body.request.approvalStatus).toBe('FINAL_APPROVED');
    expect(final.body.request.history.map(event => event.status)).toEqual(['DRAFT', 'SUBMITTED', 'MANAGER_APPROVED', 'FINANCE_APPROVED', 'FINAL_APPROVED']);
    expect(final.body.request.history[2]).toMatchObject({ actor: String(manager._id), comment: 'Manager reviewed' });
    expect(final.body.request.history[3]).toMatchObject({ actor: String(finance._id), comment: 'Finance reviewed' });
    for (const event of final.body.request.history) expect(Number.isFinite(Date.parse(event.at))).toBe(true);
    expect((await call(finance, 'get', '?view=history')).body.requests.map(doc => doc._id)).toContain(submitted._id);
  });

  test('requires rejection reasons and makes rejection terminal', async () => {
    const submitted = await submit(await createDraft());
    expect((await act(manager, submitted, 'reject', { comment: '   ' })).status).toBe(400);
    const rejected = await act(manager, submitted, 'reject', { comment: 'Insufficient justification' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.request.approvalStatus).toBe('REJECTED');
    expect(rejected.body.request.history.at(-1)).toMatchObject({ actor: String(manager._id), comment: 'Insufficient justification' });
    expect((await act(manager, rejected.body.request, 'approve')).status).toBe(409);
    expect((await act(employee, rejected.body.request, 'submit')).status).toBe(409);
  });

  test('finance can reject a manager-approved request with a recorded reason', async () => {
    const managed = (await act(manager, await submit(await createDraft()), 'approve')).body.request;
    const rejected = await act(finance, managed, 'reject', { comment: 'Allocation unavailable' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.request.history.at(-1)).toMatchObject({ status: 'REJECTED', actor: String(finance._id), comment: 'Allocation unavailable' });
  });

  test('prevents manager and finance self-approval even with malicious assignments', async () => {
    const draft = await createDraft();
    // Simulate an existing malicious/legacy assignment outside Mongoose's immutable guard.
    await Budget.collection.updateOne({ _id: new mongoose.Types.ObjectId(draft._id) }, { $set: { requester: manager._id, approvalStatus: 'SUBMITTED' } });
    expect((await act(manager, draft, 'approve')).status).toBe(403);
    await Budget.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(draft._id) },
      { $set: { requester: finance._id, approvalStatus: 'MANAGER_APPROVED', financeRequired: true } }
    );
    expect((await act(finance, draft, 'approve')).status).toBe(403);
    await Budget.collection.updateOne({ _id: new mongoose.Types.ObjectId(draft._id) }, { $set: { approvalStatus: 'FINANCE_APPROVED' } });
    expect((await act(finance, draft, 'finalize')).status).toBe(403);
  });

  test('only one concurrent approval succeeds and history contains one decision', async () => {
    const submitted = await submit(await createDraft());
    const responses = await Promise.all([act(manager, submitted, 'approve'), act(manager, submitted, 'approve')]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const stored = await Budget.findById(submitted._id).lean();
    expect(stored.history.filter(event => event.status === 'MANAGER_APPROVED')).toHaveLength(1);
    expect((await act(manager, submitted, 'approve')).status).toBe(409);
  });

  test('snapshots configured thresholds at submission and auto-finalizes requests below threshold', async () => {
    process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD = '100';
    const submitted = await submit(await createDraft(employee, { limit: 99.99 }));
    expect(submitted.financeRequired).toBe(false);
    process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD = '0';
    const approved = await act(manager, submitted, 'approve', { comment: 'Within allocation' });
    expect(approved.status).toBe(200);
    expect(approved.body.request.approvalStatus).toBe('FINAL_APPROVED');
    expect(approved.body.request.history.map(event => event.status)).toEqual(['DRAFT', 'SUBMITTED', 'MANAGER_APPROVED', 'FINANCE_APPROVED', 'FINAL_APPROVED']);
  });

  test('requires finance at the exact configured threshold', async () => {
    process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD = '100';
    const submitted = await submit(await createDraft(employee, { limit: 100 }));
    expect(submitted.financeRequired).toBe(true);
    const approved = await act(manager, submitted, 'approve');
    expect(approved.body.request.approvalStatus).toBe('MANAGER_APPROVED');
  });

  test('checks current database roles instead of trusting JWT role claims', async () => {
    await User.updateOne({ _id: otherManager._id }, { role: 'employee' });
    try {
      const submitted = await submit(await createDraft());
      await Budget.updateOne({ _id: submitted._id }, { assignedManager: otherManager._id });
      expect((await act(otherManager, submitted, 'approve')).status).toBe(403);
    } finally {
      await User.updateOne({ _id: otherManager._id }, { role: 'manager' });
    }
  });

  test('rejects deleted users even with a correctly signed unexpired token', async () => {
    const deleted = await User.create({ username: 'deleted', email: 'deleted@example.test', password: 'Test-password' });
    await User.deleteOne({ _id: deleted._id });
    expect((await call(deleted, 'get')).status).toBe(401);
  });
});
