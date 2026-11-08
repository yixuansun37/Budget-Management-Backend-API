import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, CircularProgress, Container, MenuItem, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import api from '../services/api';

const label = value => value.replace(/_/g, ' ');
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
const requestKey = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  return Array.from(bytes, (byte, index) => `${[4, 6, 8, 10].includes(index) ? '-' : ''}${byte.toString(16).padStart(2, '0')}`).join('');
};

export default function BudgetRequests() {
  const [view, setView] = useState('mine');
  const [user, setUser] = useState(null);
  const [requests, setRequests] = useState([]);
  const [managers, setManagers] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [name, setName] = useState('');
  const [limit, setLimit] = useState('');
  const [assignedManager, setAssignedManager] = useState('');
  const [comments, setComments] = useState({});
  const pendingAction = useRef(false);
  const createAttempt = useRef(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    setRequests([]);
    const load = async () => {
      try {
        const profile = await api.get('/api/users/profile');
        const role = profile.data.role || 'employee';
        const [list, reviewers] = await Promise.all([
          api.get('/api/budget-requests', { params: { view } }),
          role === 'employee' ? api.get('/api/budget-requests/reviewers') : Promise.resolve({ data: { managers: [] } }),
        ]);
        if (!active) return;
        setUser({ ...profile.data, role });
        setRequests(list.data.requests);
        setPolicy(list.data.policy);
        setManagers(reviewers.data.managers);
      } catch (failure) {
        if (active) setLoadError(failure.response?.data?.error || 'Unable to load budget requests. Please retry.');
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [view, refresh]);

  const mutate = async operation => {
    if (pendingAction.current) return;
    pendingAction.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
      setComments({});
      setRefresh(value => value + 1);
    } catch (failure) {
      setError(failure.response?.data?.error || 'Unable to save this action. Please try again.');
      // Another reviewer may already have acted. Refresh instead of retaining stale buttons.
      if (failure.response?.status === 409) setRefresh(value => value + 1);
    } finally {
      pendingAction.current = false;
      setBusy(false);
    }
  };

  const createDraft = event => {
    event.preventDefault();
    const payload = { name: name.trim(), limit: Number(limit), assignedManager };
    if (!payload.name || !Number.isFinite(payload.limit) || payload.limit <= 0 || !assignedManager) {
      setError('Enter a name, a positive budget amount, and an assigned manager.');
      return;
    }
    const fingerprint = JSON.stringify(payload);
    if (createAttempt.current?.fingerprint !== fingerprint) createAttempt.current = { fingerprint, key: requestKey() };
    mutate(async () => {
      await api.post('/api/budget-requests', { ...payload, requestKey: createAttempt.current.key });
      createAttempt.current = null;
      setName('');
      setLimit('');
      setAssignedManager('');
    });
  };

  const act = (request, action) => {
    const comment = (comments[request._id] || '').trim();
    if (action === 'reject' && !comment) {
      setError('A rejection reason is required.');
      return;
    }
    mutate(() => api.post(`/api/budget-requests/${request._id}/${action}`, { expectedVersion: request.__v, comment }));
  };

  return (
    <Container sx={{ mt: 4, pb: 6 }}>
      <Typography variant="h3" gutterBottom>
        Budget Approvals
      </Typography>
      <Typography sx={{ mb: 2 }}>Submit a draft, follow its reviews, and inspect the recorded decisions.</Typography>
      <Tabs
        value={view}
        onChange={(_, value) => {
          setView(value);
          setError('');
        }}
        aria-label="Budget request views"
        variant="scrollable"
      >
        <Tab value="mine" label="My Requests" />
        <Tab value="pending" label="Pending Approvals" disabled={!user || user.role === 'employee'} />
        <Tab value="history" label="Approval History" />
      </Tabs>
      {loading && (
        <Box role="status" sx={{ mt: 3 }}>
          <CircularProgress size={24} /> Loading budget requests…
        </Box>
      )}
      {loadError && (
        <Alert
          severity="error"
          sx={{ mt: 2 }}
          action={
            <Button color="inherit" onClick={() => setRefresh(value => value + 1)}>
              Retry
            </Button>
          }
        >
          {loadError}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}
      {!loading && !loadError && user && (
        <>
          {policy && (
            <Typography variant="body2" sx={{ my: 2 }}>
              Finance review is required at or above {money(policy.financeApprovalThreshold)}. Below that threshold, manager approval completes the remaining
              stages automatically.
            </Typography>
          )}
          {view === 'mine' && user.role === 'employee' && (
            <Box component="form" onSubmit={createDraft} sx={{ my: 3 }} aria-label="New budget request">
              <Typography variant="h5" gutterBottom>
                New Request
              </Typography>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                <TextField label="Budget name" value={name} onChange={event => setName(event.target.value)} required inputProps={{ maxLength: 200 }} />
                <TextField
                  label="Budget amount"
                  type="number"
                  value={limit}
                  onChange={event => setLimit(event.target.value)}
                  required
                  inputProps={{ min: 0.01, step: '0.01' }}
                />
                <TextField
                  select
                  label="Assigned manager"
                  value={assignedManager}
                  onChange={event => setAssignedManager(event.target.value)}
                  required
                  sx={{ minWidth: 220 }}
                >
                  {managers.map(manager => (
                    <MenuItem key={manager._id} value={manager._id}>
                      {manager.username}
                    </MenuItem>
                  ))}
                </TextField>
                <Button type="submit" variant="contained" disabled={busy || managers.length === 0}>
                  Save Draft
                </Button>
              </Stack>
              {managers.length === 0 && (
                <Alert severity="info" sx={{ mt: 2 }}>
                  No managers are available. A configured manager is required to submit requests.
                </Alert>
              )}
            </Box>
          )}
          {requests.length === 0 && (
            <Alert severity="info" sx={{ my: 2 }}>
              No requests in this view.
            </Alert>
          )}
          <Stack spacing={2} sx={{ mt: 3 }}>
            {requests.map(request => {
              const own = String(request.requester) === String(user._id);
              const manager = user.role === 'manager' && String(request.assignedManager) === String(user._id) && request.approvalStatus === 'SUBMITTED';
              const finance = user.role === 'finance_admin' && request.approvalStatus === 'MANAGER_APPROVED';
              const finalize = user.role === 'finance_admin' && request.approvalStatus === 'FINANCE_APPROVED';
              const canReview = !own && (manager || finance || finalize);
              return (
                <Card component="article" aria-label={request.name} key={request._id}>
                  <CardContent>
                    <Typography variant="h5">{request.name}</Typography>
                    <Typography>
                      {money(request.limit)} · {label(request.approvalStatus)}
                    </Typography>
                    <Typography variant="body2">
                      Requester: {request.requester} · Assigned manager: {request.assignedManager}
                    </Typography>
                    {own && request.approvalStatus === 'DRAFT' && (
                      <Button sx={{ mt: 2 }} variant="contained" disabled={busy} onClick={() => act(request, 'submit')}>
                        Submit Request
                      </Button>
                    )}
                    {canReview && (
                      <Box sx={{ mt: 2 }}>
                        <TextField
                          fullWidth
                          multiline
                          label="Review comment / rejection reason"
                          value={comments[request._id] || ''}
                          onChange={event => setComments(value => ({ ...value, [request._id]: event.target.value }))}
                          inputProps={{ maxLength: 2000 }}
                        />
                        <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
                          <Button variant="contained" disabled={busy} onClick={() => act(request, finalize ? 'finalize' : 'approve')}>
                            {finalize ? 'Final Approve' : 'Approve'}
                          </Button>
                          <Button color="error" variant="outlined" disabled={busy} onClick={() => act(request, 'reject')}>
                            Reject
                          </Button>
                        </Stack>
                      </Box>
                    )}
                    <Box component="details" sx={{ mt: 2 }}>
                      <summary>Status history</summary>
                      <Box component="ol">
                        {(request.history || []).map((entry, index) => (
                          <li key={index}>
                            {label(entry.status)} — {new Date(entry.at).toLocaleString()} — {entry.actor || 'Policy automation'}
                            {entry.comment ? ` — ${entry.comment}` : ''}
                          </li>
                        ))}
                      </Box>
                    </Box>
                  </CardContent>
                </Card>
              );
            })}
          </Stack>
        </>
      )}
    </Container>
  );
}
