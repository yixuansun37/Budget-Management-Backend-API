// Opt in with MONGO_TEST_URI. Every run uses its own disposable database.
jest.mock('../services/redisService', () => ({ get: jest.fn().mockResolvedValue(null) }));
jest.mock('../controllers/budgetController', () =>
  Object.fromEntries(['createBudget', 'getBudget', 'getAllBudgets', 'deleteBudget', 'updateBudget'].map(name => [name, jest.fn()]))
);
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const Budget = require('../models/budget');
const Expense = require('../models/expense');
const { generateToken } = require('../services/jwtService');
const app = express();
app.use('/api/budgets', require('../routes/budgetRoutes'));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
const get = query =>
  request(app)
    .get('/api/budgets/analysis')
    .query(query || {})
    .auth(generateToken('integration-user'), { type: 'bearer' });

(process.env.MONGO_TEST_URI ? describe : describe.skip)('budget analysis with real MongoDB', () => {
  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_TEST_URI, { dbName: `budget_analysis_test_${process.pid}` });
    const [travel, food, empty] = await Budget.create([
      { name: 'Travel', limit: 100 },
      { name: 'Food', limit: 50 },
      { name: 'Empty', limit: 20 },
    ]);
    await Expense.create([
      { budgetId: travel._id, description: 'Before month', amount: 500, createdAt: new Date('2024-01-31T23:59:59.999Z') },
      { budgetId: travel._id, description: 'Start boundary', amount: 100.1, createdAt: new Date('2024-02-01T00:00:00Z') },
      { budgetId: travel._id, description: 'Leap day', amount: 25.05, createdAt: new Date('2024-02-29T23:59:59.999Z') },
      { budgetId: travel._id, description: 'Next month', amount: 600, createdAt: new Date('2024-03-01T00:00:00Z') },
      { budgetId: food._id, description: 'Food', amount: 0.1, createdAt: new Date('2024-02-02T00:00:00Z') },
      { budgetId: food._id, description: 'Food', amount: 0.2, createdAt: new Date('2024-02-02T00:00:00Z') },
      { budgetId: new mongoose.Types.ObjectId(), description: 'Orphan excluded', amount: 999, createdAt: new Date('2024-02-02T00:00:00Z') },
    ]);
    expect(empty.name).toBe('Empty');
  });
  afterAll(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  test('aggregates real persisted expenses and respects UTC boundaries and category', async () => {
    const response = await get({ month: '2024-02', category: 'Travel' });
    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ budget: 100, actual: 125.15, remaining: -25.15, variance: 25.15, expenseCount: 2 });
    expect(response.body.categories).toEqual(['Empty', 'Food', 'Travel']);
  });
  test('includes budgets without expenses and excludes orphan expenses', async () => {
    const response = await get({ month: '2024-02' });
    expect(response.body.summary).toEqual({ budget: 170, actual: 125.45, remaining: 44.55, variance: -44.55, expenseCount: 4 });
    expect(response.body.budgets.find(row => row.category === 'Empty').actual).toBe(0);
  });
  test('returns all-time totals when month is omitted', async () => {
    const response = await get({ category: 'Travel' });
    expect(response.body.summary.actual).toBe(1225.15);
    expect(response.body.summary.expenseCount).toBe(4);
  });
  test('keeps full limits when a month has no expenses', async () => {
    const response = await get({ month: '2020-01' });
    expect(response.body.summary).toEqual({ budget: 170, actual: 0, remaining: 170, variance: -170, expenseCount: 0 });
  });
  test('returns an empty collection for unknown categories', async () => {
    expect((await get({ category: 'Missing' })).body.budgets).toEqual([]);
  });
});
