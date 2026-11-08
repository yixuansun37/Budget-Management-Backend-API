const express = require('express');
const { createBudget, getBudget, getAllBudgets, deleteBudget, updateBudget } = require('../controllers/budgetController');
const authenticate = require('../middleware/authMiddleware');
const authorize = require('../middleware/authorize');
const { getBudgetAnalysis } = require('../controllers/budgetAnalysisController');

const router = express.Router();

router.post('/', authenticate, authorize('finance_admin'), createBudget);
router.get('/analysis', authenticate, getBudgetAnalysis);
router.get('/:id', authenticate, getBudget);
router.get('/', authenticate, getAllBudgets);
router.delete('/:id', authenticate, authorize('finance_admin'), deleteBudget);
router.put('/:id', authenticate, authorize('finance_admin'), updateBudget);

module.exports = router;
