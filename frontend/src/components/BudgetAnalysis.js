import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Grid,
  MenuItem,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import api from '../services/api';

const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

export default function BudgetAnalysis() {
  const [month, setMonth] = useState('');
  const [category, setCategory] = useState('');
  const [data, setData] = useState(null);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setData(null);
    api
      .get('/api/budgets/analysis', { params: { ...(month && { month }), ...(category && { category }) } })
      .then(response => {
        if (!active) return;
        setData(response.data);
        setCategories(response.data.categories);
      })
      .catch(() => {
        if (active) setError('Unable to load budget analysis. Please try again.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [month, category, retry]);

  return (
    <Paper component="section" aria-labelledby="budget-analysis-title" sx={{ p: 3, mb: 4 }}>
      <Typography id="budget-analysis-title" variant="h4" gutterBottom>
        Budget vs. Actual
      </Typography>
      <Typography variant="body2" sx={{ mb: 2 }}>
        Compare recorded expenses with full budget limits. Month uses UTC expense dates; categories are budget names. Positive variance means overspending;
        negative remaining balances are retained. Amounts shown in USD.
      </Typography>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 3 }}>
        <TextField label="Expense month" type="month" value={month} onChange={event => setMonth(event.target.value)} InputLabelProps={{ shrink: true }} />
        <TextField select label="Category (budget name)" value={category} onChange={event => setCategory(event.target.value)} sx={{ minWidth: 220 }}>
          <MenuItem value="">All categories</MenuItem>
          {categories.map(name => (
            <MenuItem key={name} value={name}>
              {name}
            </MenuItem>
          ))}
        </TextField>
        <Button
          onClick={() => {
            setMonth('');
            setCategory('');
          }}
        >
          Clear filters
        </Button>
      </Box>
      {loading && (
        <Box role="status">
          <CircularProgress size={24} aria-label="Loading budget analysis" /> Loading budget analysis…
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
          <Grid container spacing={2} sx={{ mb: 2 }}>
            {Object.entries({ budget: 'Budget', actual: 'Actual expenses', remaining: 'Remaining balance', variance: 'Variance (actual − budget)' }).map(
              ([key, label]) => (
                <Grid item xs={12} sm={6} md={3} key={key}>
                  <Typography>{label}</Typography>
                  <Typography variant="h5">{money(data.summary[key])}</Typography>
                </Grid>
              )
            )}
          </Grid>
          {data.budgets.length === 0 ? (
            <Alert severity="info">No budgets match these filters.</Alert>
          ) : (
            <>
              {data.summary.expenseCount === 0 && <Alert severity="info">No expenses recorded for these filters. Budget limits still apply.</Alert>}
              <TableContainer>
                <Table aria-label="Budget versus actual by category">
                  <TableHead>
                    <TableRow>
                      {['Category', 'Budget', 'Actual', 'Remaining', 'Variance'].map(label => (
                        <TableCell key={label}>{label}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.budgets.map(row => (
                      <TableRow key={row.budgetId}>
                        <TableCell component="th" scope="row">
                          {row.category}
                        </TableCell>
                        {['budget', 'actual', 'remaining', 'variance'].map(key => (
                          <TableCell key={key}>{money(row[key])}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          )}
        </>
      )}
    </Paper>
  );
}
