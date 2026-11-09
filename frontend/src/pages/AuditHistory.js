import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Container, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import api from '../services/api';

const actions = ['BUDGET_CREATED', 'BUDGET_MODIFIED', 'BUDGET_SUBMITTED', 'BUDGET_APPROVED', 'BUDGET_REJECTED', 'BUDGET_DELETED'];
const emptyFilters = { targetId: '', action: '', from: '', to: '' };
const label = action => action.replace(/_/g, ' ');

export default function AuditHistory() {
  const [filters, setFilters] = useState(emptyFilters);
  const [query, setQuery] = useState({ page: 1, pageSize: 20 });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setData(null);
    api
      .get('/api/audit-trail', { params: query })
      .then(response => {
        if (active) setData(response.data);
      })
      .catch(failure => {
        if (active) setError(failure.response?.data?.error || 'Unable to load audit history. Please retry.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [query, retry]);

  const updateFilter = event => setFilters(value => ({ ...value, [event.target.name]: event.target.value }));
  const applyFilters = event => {
    event.preventDefault();
    const selected = Object.fromEntries(
      Object.entries(filters)
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value)
    );
    setQuery({ ...selected, page: 1, pageSize: 20 });
  };
  const clearFilters = () => {
    setFilters(emptyFilters);
    setQuery({ page: 1, pageSize: 20 });
  };

  return (
    <Container sx={{ mt: 4, pb: 6 }}>
      <Typography variant="h3" gutterBottom>
        Audit History
      </Typography>
      <Typography sx={{ mb: 3 }}>
        Read-only budget and approval activity. Results follow your server-enforced access permissions. Date filters include whole UTC days.
      </Typography>
      <Paper component="form" aria-label="Audit history filters" onSubmit={applyFilters} sx={{ p: 3, mb: 3 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} flexWrap="wrap" useFlexGap>
          <TextField
            label="Budget / request ID"
            name="targetId"
            value={filters.targetId}
            onChange={updateFilter}
            inputProps={{ pattern: '[a-fA-F0-9]{24}', maxLength: 24 }}
          />
          <TextField select label="Action" name="action" value={filters.action} onChange={updateFilter} sx={{ minWidth: 220 }}>
            <MenuItem value="">All actions</MenuItem>
            {actions.map(action => (
              <MenuItem key={action} value={action}>
                {label(action)}
              </MenuItem>
            ))}
          </TextField>
          <TextField label="From date (UTC)" name="from" type="date" value={filters.from} onChange={updateFilter} InputLabelProps={{ shrink: true }} />
          <TextField label="To date (UTC)" name="to" type="date" value={filters.to} onChange={updateFilter} InputLabelProps={{ shrink: true }} />
          <Button type="submit" variant="contained">
            Apply filters
          </Button>
          <Button onClick={clearFilters}>Clear filters</Button>
        </Stack>
      </Paper>
      {loading && (
        <Box role="status">
          <CircularProgress size={24} /> Loading audit history…
        </Box>
      )}
      {error && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" onClick={() => setRetry(value => value + 1)}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      )}
      {!loading && data && (
        <>
          <Typography sx={{ mb: 2 }}>{data.total} audit records</Typography>
          {data.records.length === 0 ? (
            <Alert severity="info">No audit records match these filters.</Alert>
          ) : (
            <Stack spacing={2}>
              {data.records.map(record => (
                <Paper component="article" aria-label={`${label(record.action)} ${record.targetId}`} key={record._id} sx={{ p: 3 }}>
                  <Typography variant="h6">{label(record.action)}</Typography>
                  <Typography>Budget / request: {record.targetId}</Typography>
                  <Typography>
                    Actor: {record.actorId || 'Policy automation'} ({record.actorRole})
                  </Typography>
                  <Typography component="time" dateTime={record.timestamp}>
                    {new Date(record.timestamp).toLocaleString()}
                  </Typography>
                  <Box component="details" sx={{ mt: 2 }}>
                    <summary>Before / after changes</summary>
                    <Typography variant="subtitle2">Before</Typography>
                    <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {JSON.stringify(record.before, null, 2)}
                    </Box>
                    <Typography variant="subtitle2">After</Typography>
                    <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {JSON.stringify(record.after, null, 2)}
                    </Box>
                  </Box>
                </Paper>
              ))}
            </Stack>
          )}
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 3 }} aria-label="Audit pagination">
            <Button disabled={data.page <= 1} onClick={() => setQuery(value => ({ ...value, page: value.page - 1 }))}>
              Previous page
            </Button>
            <Typography>
              Page {data.page} of {Math.max(data.totalPages, 1)}
            </Typography>
            <Button disabled={data.page >= data.totalPages} onClick={() => setQuery(value => ({ ...value, page: value.page + 1 }))}>
              Next page
            </Button>
          </Stack>
        </>
      )}
    </Container>
  );
}
