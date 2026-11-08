jest.mock('../models/budget', () => ({ find: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/expense', () => ({ aggregate: jest.fn() }));
jest.mock('../services/redisService', () => ({ get: jest.fn().mockResolvedValue(null) }));
jest.mock('../controllers/budgetController', () =>
  Object.fromEntries(['createBudget', 'getBudget', 'getAllBudgets', 'deleteBudget', 'updateBudget'].map(name => [name, jest.fn()]))
);

const express = require('express');
const request = require('supertest');
const Budget = require('../models/budget');
const Expense = require('../models/expense');
const { generateToken } = require('../services/jwtService');
const routes = require('../routes/budgetRoutes');
const app = express();
app.use('/api/budgets', routes);
app.use((err, req, res, next) => res.status(500).json({ error: 'Analysis unavailable' }));
const token = generateToken('analysis-test-user');
const get = query =>
  request(app)
    .get('/api/budgets/analysis')
    .query(query || {})
    .auth(token, { type: 'bearer' });

beforeEach(() => {
  jest.clearAllMocks();
  Budget.find.mockReturnValue({
    sort: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { _id: 'travel', name: 'Travel', limit: 100 },
        { _id: 'food', name: 'Food', limit: 0 },
        { _id: 'office', name: 'Office', limit: 0.3 },
      ]),
    }),
  });
  Budget.distinct.mockResolvedValue(['Travel', 'Food', 'Office']);
  Expense.aggregate.mockResolvedValue([
    { _id: 'travel', actual: { toString: () => '125.15' }, expenseCount: 2 },
    { _id: 'office', actual: { toString: () => '0.30' }, expenseCount: 2 },
  ]);
});

test('requires authentication before returning analysis', async () => {
  expect((await request(app).get('/api/budgets/analysis')).status).toBe(401);
  expect((await request(app).get('/api/budgets/analysis').auth('invalid', { type: 'bearer' })).status).toBe(401);
  expect(Budget.find).not.toHaveBeenCalled();
});

test('returns reconciled metrics, negative remaining, zero budgets and decimal totals', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.body.summary).toEqual({ budget: 100.3, actual: 125.45, remaining: -25.15, variance: 25.15, expenseCount: 4 });
  expect(response.body.budgets[0]).toMatchObject({ category: 'Travel', remaining: -25.15, variance: 25.15 });
  expect(response.body.budgets[1]).toMatchObject({ category: 'Food', budget: 0, actual: 0, remaining: 0, variance: 0 });
  expect(response.body.categories).toEqual(['Food', 'Office', 'Travel']);
});

test('applies category and inclusive/exclusive UTC month boundaries to database queries', async () => {
  const response = await get({ month: '2024-02', category: 'Travel' });
  expect(response.status).toBe(200);
  expect(Budget.find).toHaveBeenCalledWith({ ...require('../services/budgetVisibility').approvedBudgets, name: 'Travel' });
  expect(Expense.aggregate.mock.calls[0][0][0].$match).toEqual({
    budgetId: { $in: ['travel', 'food', 'office'] },
    createdAt: { $gte: new Date('2024-02-01T00:00:00Z'), $lt: new Date('2024-03-01T00:00:00Z') },
  });
});

test('December rolls into the next year', async () => {
  await get({ month: '2025-12' });
  expect(Expense.aggregate.mock.calls[0][0][0].$match.createdAt.$lt).toEqual(new Date('2026-01-01T00:00:00Z'));
});

test.each(['2024-13', '2024-00', '2024-2', '0000-01', '', 'no-date'])('rejects invalid month %j', async month => {
  expect((await get({ month })).status).toBe(400);
  expect(Budget.find).not.toHaveBeenCalled();
});

test.each([{ 'category[$ne]': 'Travel' }, { category: '' }, { category: 'x'.repeat(201) }, { 'month[$ne]': '2024-01' }])(
  'rejects malformed filters %j',
  async query => {
    expect((await get(query)).status).toBe(400);
  }
);

test('returns empty results without querying expenses when no budgets match', async () => {
  Budget.find.mockReturnValue({ sort: () => ({ lean: async () => [] }) });
  const response = await get({ category: 'Unknown' });
  expect(response.status).toBe(200);
  expect(response.body.budgets).toEqual([]);
  expect(response.body.summary).toEqual({ budget: 0, actual: 0, remaining: 0, variance: 0, expenseCount: 0 });
  expect(Expense.aggregate).not.toHaveBeenCalled();
});

test('propagates database failures to error middleware', async () => {
  Expense.aggregate.mockRejectedValue(new Error('database unavailable'));
  expect((await get()).status).toBe(500);
});
