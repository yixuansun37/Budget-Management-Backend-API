import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AuditHistory from './AuditHistory';
import api from '../services/api';

jest.mock('../services/api', () => ({ get: jest.fn() }));
const targetId = '64c9f8f2a73c2f001b3c68f4';
const record = {
  _id: 'event-1',
  actorId: 'actor-1',
  actorRole: 'employee',
  action: 'BUDGET_MODIFIED',
  targetId,
  timestamp: '2026-01-01T12:00:00Z',
  before: { limit: 100 },
  after: { limit: 200 },
};
const result = { records: [record], page: 1, pageSize: 20, total: 21, totalPages: 2 };
beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: result });
});

test('shows loading followed by read-only actor, target and before/after changes', async () => {
  let resolve;
  api.get.mockReturnValue(
    new Promise(done => {
      resolve = done;
    })
  );
  render(<AuditHistory />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading audit history');
  await act(async () => resolve({ data: result }));
  expect(screen.getByRole('article')).toHaveTextContent('actor-1 (employee)');
  expect(screen.getByRole('article')).toHaveTextContent(targetId);
  fireEvent.click(screen.getByText('Before / after changes'));
  expect(screen.getByRole('article')).toHaveTextContent('"limit": 100');
  expect(screen.getByRole('article')).toHaveTextContent('"limit": 200');
  expect(screen.queryByRole('button', { name: /delete|edit/i })).not.toBeInTheDocument();
});

test('applies ID, action and UTC date filters together and clears them', async () => {
  render(<AuditHistory />);
  await screen.findByRole('article');
  fireEvent.change(screen.getByLabelText('Budget / request ID'), { target: { value: targetId } });
  fireEvent.change(screen.getByLabelText('From date (UTC)'), { target: { value: '2026-01-01' } });
  fireEvent.change(screen.getByLabelText('To date (UTC)'), { target: { value: '2026-01-31' } });
  fireEvent.mouseDown(screen.getByLabelText('Action'));
  fireEvent.click(await screen.findByRole('option', { name: 'BUDGET MODIFIED' }));
  expect(api.get).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  await waitFor(() =>
    expect(api.get).toHaveBeenLastCalledWith('/api/audit-trail', {
      params: { targetId, action: 'BUDGET_MODIFIED', from: '2026-01-01', to: '2026-01-31', page: 1, pageSize: 20 },
    })
  );
  await screen.findByRole('article');
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/api/audit-trail', { params: { page: 1, pageSize: 20 } }));
  expect(screen.getByLabelText('Budget / request ID')).toHaveValue('');
});

test('paginates with current filters and respects last-page boundaries', async () => {
  api.get.mockImplementation((path, { params }) => Promise.resolve({ data: { ...result, page: params.page } }));
  render(<AuditHistory />);
  await screen.findByRole('article');
  expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Budget / request ID'), { target: { value: targetId } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  await screen.findByRole('article');
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  await screen.findByText('Page 2 of 2');
  expect(api.get).toHaveBeenLastCalledWith('/api/audit-trail', { params: { targetId, page: 2, pageSize: 20 } });
  expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
  await screen.findByText('Page 1 of 2');
});

test('shows empty data with no next page', async () => {
  api.get.mockResolvedValue({ data: { ...result, records: [], total: 0, totalPages: 0 } });
  render(<AuditHistory />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No audit records match these filters');
  expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
});

test('shows server errors and retries without showing misleading results', async () => {
  api.get.mockRejectedValueOnce({ response: { status: 403, data: { error: 'Insufficient permission' } } });
  render(<AuditHistory />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Insufficient permission');
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('article');
  expect(api.get).toHaveBeenCalledTimes(2);
});

test('ignores stale responses when filters are changed', async () => {
  let resolveOld;
  api.get.mockReturnValueOnce(
    new Promise(done => {
      resolveOld = done;
    })
  );
  render(<AuditHistory />);
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  await screen.findByRole('article');
  await act(async () => resolveOld({ data: { ...result, records: [], total: 0 } }));
  expect(screen.getByRole('article')).toBeInTheDocument();
  expect(screen.queryByText('No audit records match these filters.')).not.toBeInTheDocument();
});
