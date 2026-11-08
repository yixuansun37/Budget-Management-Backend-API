import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BudgetAnalysis from './BudgetAnalysis';
import api from '../services/api';

jest.mock('../services/api', () => ({ get: jest.fn() }));
const report = {
  categories: ['Travel', 'Food'],
  summary: { budget: 100, actual: 125, remaining: -25, variance: 25, expenseCount: 1 },
  budgets: [{ budgetId: '1', category: 'Travel', budget: 100, actual: 125, remaining: -25, variance: 25 }],
};
beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: report });
});

test('shows loading and then server metrics, including overspending', async () => {
  let resolve;
  api.get.mockReturnValue(
    new Promise(done => {
      resolve = done;
    })
  );
  render(<BudgetAnalysis />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading budget analysis');
  await act(async () => resolve({ data: report }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  const row = within(screen.getByRole('row', { name: /Travel/ }));
  expect(row.getByText('$100.00')).toBeInTheDocument();
  expect(row.getByText('$125.00')).toBeInTheDocument();
  expect(row.getByText('-$25.00')).toBeInTheDocument();
  expect(row.getByText('$25.00')).toBeInTheDocument();
});

test('requests monthly and category filters and clears them', async () => {
  render(<BudgetAnalysis />);
  await screen.findByRole('table');
  fireEvent.change(screen.getByLabelText('Expense month'), { target: { value: '2024-02' } });
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/api/budgets/analysis', { params: { month: '2024-02' } }));
  fireEvent.mouseDown(screen.getByLabelText('Category (budget name)'));
  fireEvent.click(await screen.findByRole('option', { name: 'Travel' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/api/budgets/analysis', { params: { month: '2024-02', category: 'Travel' } }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/api/budgets/analysis', { params: {} }));
  await screen.findByRole('table');
});

test('shows errors with retry rather than misleading zero metrics', async () => {
  api.get.mockRejectedValueOnce(new Error('offline'));
  render(<BudgetAnalysis />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load budget analysis');
  expect(screen.queryByText('Actual expenses')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('table');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('shows an empty budget result', async () => {
  api.get.mockResolvedValue({ data: { ...report, budgets: [], summary: { budget: 0, actual: 0, remaining: 0, variance: 0, expenseCount: 0 } } });
  render(<BudgetAnalysis />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No budgets match');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

test('distinguishes no expenses from no budgets', async () => {
  api.get.mockResolvedValue({ data: { ...report, summary: { ...report.summary, expenseCount: 0 } } });
  render(<BudgetAnalysis />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No expenses recorded');
  expect(screen.getByRole('table')).toBeInTheDocument();
});

test('ignores an older response after filters change', async () => {
  let resolveOld;
  api.get.mockReturnValueOnce(
    new Promise(done => {
      resolveOld = done;
    })
  );
  render(<BudgetAnalysis />);
  fireEvent.change(screen.getByLabelText('Expense month'), { target: { value: '2024-02' } });
  await screen.findByRole('table');
  await act(async () => resolveOld({ data: { ...report, budgets: [] } }));
  expect(screen.getByRole('table')).toBeInTheDocument();
  expect(screen.queryByText('No budgets match these filters.')).not.toBeInTheDocument();
});
