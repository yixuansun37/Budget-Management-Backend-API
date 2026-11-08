import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BudgetRequests from './BudgetRequests';
import api from '../services/api';

jest.mock('../services/api', () => ({ get: jest.fn(), post: jest.fn() }));

let role, userId, requests;
const draft = {
  _id: 'request-1',
  name: 'Travel request',
  limit: 500,
  requester: 'employee-1',
  assignedManager: 'manager-1',
  approvalStatus: 'DRAFT',
  __v: 0,
  history: [{ status: 'DRAFT', actor: 'employee-1', at: '2026-01-01T12:00:00Z', comment: 'Created' }],
};
beforeEach(() => {
  jest.clearAllMocks();
  global.crypto = { randomUUID: () => '11111111-1111-4111-8111-111111111111' };
  role = 'employee';
  userId = 'employee-1';
  requests = [draft];
  api.get.mockImplementation(path => {
    if (path === '/api/users/profile') return Promise.resolve({ data: { _id: userId, role } });
    if (path.endsWith('/reviewers')) return Promise.resolve({ data: { managers: [{ _id: 'manager-1', username: 'Reviewer' }] } });
    return Promise.resolve({ data: { requests, policy: { financeApprovalThreshold: 1000 }, role } });
  });
  api.post.mockResolvedValue({ data: { request: draft } });
});

test('employees can submit own drafts and inspect status history, but cannot approve', async () => {
  render(<BudgetRequests />);
  const card = await screen.findByRole('article', { name: 'Travel request' });
  expect(screen.getByRole('tab', { name: 'Pending Approvals' })).toBeDisabled();
  expect(within(card).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  fireEvent.click(within(card).getByRole('button', { name: 'Submit Request' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/budget-requests/request-1/submit', { expectedVersion: 0, comment: '' }));
  expect(within(card).getByText(/Created/)).toHaveTextContent('employee-1');
});

test('managers see assigned approvals and must give a rejection reason', async () => {
  role = 'manager';
  userId = 'manager-1';
  requests = [{ ...draft, approvalStatus: 'SUBMITTED', __v: 1 }];
  render(<BudgetRequests />);
  await screen.findByRole('article');
  expect(screen.queryByRole('form', { name: 'New budget request' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Pending Approvals' }));
  await screen.findByRole('button', { name: 'Reject' });
  expect(api.get).toHaveBeenCalledWith('/api/budget-requests', { params: { view: 'pending' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  expect(screen.getByRole('alert')).toHaveTextContent('A rejection reason is required');
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Review comment / rejection reason'), { target: { value: ' Missing supporting details ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith('/api/budget-requests/request-1/reject', { expectedVersion: 1, comment: 'Missing supporting details' })
  );
});

test('managers approve with a version and comment', async () => {
  role = 'manager';
  userId = 'manager-1';
  requests = [{ ...draft, approvalStatus: 'SUBMITTED', __v: 1 }];
  render(<BudgetRequests />);
  await screen.findByRole('button', { name: 'Approve' });
  fireEvent.change(screen.getByLabelText('Review comment / rejection reason'), { target: { value: 'Reviewed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/budget-requests/request-1/approve', { expectedVersion: 1, comment: 'Reviewed' }));
});

test('finance can perform final approval and view history', async () => {
  role = 'finance_admin';
  userId = 'finance-1';
  requests = [{ ...draft, approvalStatus: 'FINANCE_APPROVED', __v: 3 }];
  render(<BudgetRequests />);
  fireEvent.click(await screen.findByRole('button', { name: 'Final Approve' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/budget-requests/request-1/finalize', { expectedVersion: 3, comment: '' }));
  await screen.findByRole('article');
  fireEvent.click(screen.getByRole('tab', { name: 'Approval History' }));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/budget-requests', { params: { view: 'history' } }));
});

test('never offers self approval even to a finance admin', async () => {
  role = 'finance_admin';
  userId = 'employee-1';
  requests = [{ ...draft, approvalStatus: 'MANAGER_APPROVED' }];
  render(<BudgetRequests />);
  await screen.findByRole('article');
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
});

test('shows loading, empty results and retryable errors', async () => {
  api.get.mockRejectedValueOnce(new Error('offline'));
  requests = [];
  render(<BudgetRequests />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading budget requests');
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('No requests in this view.')).toBeInTheDocument();
});

test('refreshes stale requests after a conflicting approval', async () => {
  role = 'manager';
  userId = 'manager-1';
  requests = [{ ...draft, approvalStatus: 'SUBMITTED' }];
  api.post.mockImplementation(async () => {
    requests = [{ ...draft, approvalStatus: 'MANAGER_APPROVED' }];
    throw { response: { status: 409, data: { error: 'Request changed. Refresh and try again.' } } };
  });
  render(<BudgetRequests />);
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Request changed');
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument());
});

test('reuses a draft idempotency key after an uncertain network failure', async () => {
  requests = [];
  api.post.mockRejectedValueOnce(new Error('network interrupted'));
  render(<BudgetRequests />);
  await screen.findByRole('form', { name: 'New budget request' });
  fireEvent.change(screen.getByLabelText(/^Budget name/), { target: { value: 'Travel' } });
  fireEvent.change(screen.getByLabelText(/^Budget amount/), { target: { value: '500' } });
  fireEvent.mouseDown(screen.getByLabelText(/^Assigned manager/));
  fireEvent.click(await screen.findByRole('option', { name: 'Reviewer' }));
  fireEvent.submit(screen.getByRole('form', { name: 'New budget request' }));
  await screen.findByText('Unable to save this action. Please try again.');
  fireEvent.submit(screen.getByRole('form', { name: 'New budget request' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(api.post.mock.calls[0][1]).toEqual(api.post.mock.calls[1][1]);
  expect(api.post.mock.calls[0][1].requestKey).toMatch(/^[a-f\d-]{36}$/);
});
