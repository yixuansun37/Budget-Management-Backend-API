// Opt in with MONGO_TEST_URI. Uses and drops only its own per-process test database.
jest.mock('../services/redisService', () => ({ get: jest.fn(), set: jest.fn(), del: jest.fn() }));
jest.mock('../apache-kafka/kafkaService', () => ({ publishEvent: jest.fn() }));
jest.mock('../services/elasticService', () => ({ indices: { exists: jest.fn().mockResolvedValue(true) }, index: jest.fn() }));
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const grpc = require('@grpc/grpc-js');
const { graphql } = require('graphql');
const Budget = require('../models/budget');
const Expense = require('../models/expense');
const User = require('../models/user');
const redisClient = require('../services/redisService');
const schema = require('../graphql/schema');
const handlers = require('../grpcServer').handlers;
const { generateToken } = require('../services/jwtService');
const app = express();
app.use(express.json());
app.use('/api/budgets', require('../routes/budgetRoutes'));
app.use('/api/expenses', require('../routes/expenseRoutes'));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

(process.env.MONGO_TEST_URI ? describe : describe.skip)('approval visibility and legacy API bypass protection', () => {
  let employee, finance, legacy, draft, final;
  const http = (method, path, body, user = employee) =>
    request(app)
      [method](path)
      .auth(generateToken(String(user._id)), { type: 'bearer' })
      .send(body);
  const rpc = (method, requestBody = {}, user = employee, token) =>
    new Promise(resolve => {
      const metadata = new grpc.Metadata();
      if (user) metadata.set('authorization', 'Bearer ' + (token || generateToken(String(user._id))));
      const call = { metadata, request: requestBody, destroy: error => resolve({ error }), write: jest.fn(), end: () => resolve({ data: [] }) };
      handlers[method](call, method === 'StreamExpenses' ? undefined : (error, data) => resolve({ error, data }));
    });
  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_TEST_URI, { dbName: `budget_visibility_test_${process.pid}` });
    [employee, finance] = await User.create([
      { username: 'visibility-employee', email: 'employee@visibility.test', password: 'test-password', role: 'employee' },
      { username: 'visibility-finance', email: 'finance@visibility.test', password: 'test-password', role: 'finance_admin' },
    ]);
    [legacy, draft, final] = await Budget.create([
      { name: 'Legacy', limit: 100 },
      {
        name: 'Secret draft',
        limit: 500,
        requester: employee._id,
        assignedManager: finance._id,
        approvalStatus: 'DRAFT',
        history: [{ status: 'DRAFT', actor: employee._id, role: 'employee', at: new Date(), comment: 'Private reason' }],
      },
      {
        name: 'Final',
        limit: 200,
        requester: employee._id,
        assignedManager: finance._id,
        approvalStatus: 'FINAL_APPROVED',
        history: [{ status: 'FINAL_APPROVED', actor: finance._id, role: 'finance_admin', at: new Date(), comment: 'Private final reason' }],
        approvalThreshold: 100,
        financeRequired: true,
      },
    ]);
    await Expense.create([
      { budgetId: legacy._id, description: 'Legacy expense', amount: 3 },
      { budgetId: final._id, description: 'Final expense', amount: 4 },
      { budgetId: draft._id, description: 'Private expense fixture', amount: 10 },
    ]);
    redisClient.get.mockImplementation(async key => (key.startsWith('budget:') ? JSON.stringify(draft) : null));
  });
  afterAll(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  test('REST lists only approved budgets and excludes private approval fields', async () => {
    const response = await http('get', '/api/budgets');
    expect(response.status).toBe(200);
    expect(response.body.map(budget => budget.name).sort()).toEqual(['Final', 'Legacy']);
    for (const budget of response.body) {
      for (const field of ['requester', 'assignedManager', 'history', 'approvalThreshold', 'financeRequired']) expect(budget[field]).toBeUndefined();
    }
  });
  test('REST by-ID reads cannot expose drafts or stale cached private fields', async () => {
    expect((await http('get', '/api/budgets/' + draft._id)).status).toBe(404);
    const response = await http('get', '/api/budgets/' + final._id);
    expect(response.status).toBe(200);
    expect(response.body.source).toBe('database');
    expect(response.body.budget.history).toBeUndefined();
    expect(response.body.budget.name).toBe('Final');
  });
  test('analysis omits draft amounts and category names', async () => {
    const response = await http('get', '/api/budgets/analysis');
    expect(response.body.categories).toEqual(['Final', 'Legacy']);
    expect(response.body.summary.budget).toBe(300);
    expect(response.body.summary.actual).toBe(7);
  });
  test('employees cannot directly create or alter budgets', async () => {
    expect((await http('post', '/api/budgets', { name: 'Bypass', limit: 1 })).status).toBe(403);
    expect((await http('put', '/api/budgets/' + legacy._id, { limit: 1 })).status).toBe(403);
    expect((await http('delete', '/api/budgets/' + legacy._id)).status).toBe(403);
  });
  test('even finance admins cannot alter/delete request-backed budgets through legacy CRUD', async () => {
    for (const budget of [draft, final]) {
      expect((await http('put', '/api/budgets/' + budget._id, { limit: 1 }, finance)).status).toBe(404);
      expect((await http('delete', '/api/budgets/' + budget._id, undefined, finance)).status).toBe(404);
      expect((await Budget.findById(budget._id)).limit).toBe(budget.limit);
    }
  });
  test('finance admins can still manage legacy budgets', async () => {
    const create = await http('post', '/api/budgets', { name: 'Admin legacy', limit: 10 }, finance);
    expect(create.status).toBe(201);
    const id = create.body.budget._id;
    expect((await http('put', '/api/budgets/' + id, { name: 'Updated', limit: 11 }, finance)).status).toBe(200);
    expect((await http('delete', '/api/budgets/' + id, undefined, finance)).status).toBe(200);
  });
  test('REST cannot record expenses against an unapproved request', async () => {
    const response = await http('post', '/api/expenses', { budgetId: String(draft._id), description: 'Attempt', amount: 2 });
    expect(response.status).toBe(404);
    expect(await Expense.countDocuments({ description: 'Attempt' })).toBe(0);
  });
  test('GraphQL excludes drafts and their expenses', async () => {
    const budgets = await graphql(schema, '{ budgets { id name } }');
    expect(budgets.errors).toBeUndefined();
    expect(budgets.data.budgets.map(budget => budget.name).sort()).toEqual(['Final', 'Legacy']);
    const expenses = await graphql(schema, `{ expenses(budgetId: "${draft._id}") { id description } }`);
    expect(expenses.errors).toBeUndefined();
    expect(expenses.data.expenses).toEqual([]);
  });
  test.each(Object.keys(handlers))('gRPC %s rejects unauthenticated calls', async method => {
    const response = await rpc(method, {}, null);
    expect(response.error.code).toBe(grpc.status.UNAUTHENTICATED);
  });
  test.each(['CreateBudget', 'UpdateBudget', 'DeleteBudget'])('gRPC %s requires current finance authority', async method => {
    const response = await rpc(method, { name: 'Bypass', limit: 1, budgetId: String(legacy._id) });
    expect(response.error.code).toBe(grpc.status.PERMISSION_DENIED);
  });
  test('gRPC reads approved budgets and rejects drafts, including expense streams', async () => {
    const list = await rpc('ListBudgets');
    expect(list.error).toBeNull();
    expect(list.data.budgets.map(budget => budget.name).sort()).toEqual(['Final', 'Legacy']);
    expect((await rpc('GetBudget', { budgetId: String(final._id) })).data.name).toBe('Final');
    for (const method of ['GetBudget', 'GetBudgetSummary', 'GetExpenses', 'StreamExpenses']) {
      expect((await rpc(method, { budgetId: String(draft._id) })).error).toBeTruthy();
    }
  });
  test('gRPC cannot mutate managed budgets even as finance admin', async () => {
    for (const budget of [draft, final]) {
      expect((await rpc('UpdateBudget', { budgetId: String(budget._id), name: 'Altered', limit: 1 }, finance)).error).toBeTruthy();
      expect((await rpc('DeleteBudget', { budgetId: String(budget._id) }, finance)).error).toBeTruthy();
      expect((await Budget.findById(budget._id)).limit).toBe(budget.limit);
    }
    expect((await rpc('AddExpense', { budgetId: String(draft._id), description: 'gRPC attempt', amount: 1 })).error).toBeTruthy();
  });
  test('gRPC preserves authorized legacy CRUD and checks role changes after token issuance', async () => {
    const created = await rpc('CreateBudget', { name: 'gRPC legacy', limit: 10 }, finance);
    expect(created.error).toBeNull();
    const budgetId = created.data.budgetId;
    expect((await rpc('UpdateBudget', { budgetId, name: 'gRPC updated', limit: 11 }, finance)).data.budget.limit).toBe(11);
    expect((await rpc('DeleteBudget', { budgetId }, finance)).data.deleted).toBe(true);
    const token = generateToken(String(finance._id));
    try {
      await User.updateOne({ _id: finance._id }, { role: 'employee' });
      expect((await rpc('CreateBudget', { name: 'Stale authority', limit: 1 }, finance, token)).error.code).toBe(grpc.status.PERMISSION_DENIED);
    } finally {
      await User.updateOne({ _id: finance._id }, { role: 'finance_admin' });
    }
  });
  test('gRPC rejects nonexistent users and revoked tokens', async () => {
    expect((await rpc('ListBudgets', {}, { _id: new mongoose.Types.ObjectId() })).error.code).toBe(grpc.status.UNAUTHENTICATED);
    redisClient.get.mockResolvedValueOnce('true');
    expect((await rpc('ListBudgets')).error.code).toBe(grpc.status.UNAUTHENTICATED);
  });
});
