const Budget = require('../models/budget');
const { approvedBudgets } = require('../services/budgetVisibility');
const Expense = require('../models/expense');

/**
 * @swagger
 * /api/budgets/analysis:
 *   get:
 *     summary: Compare budget limits with actual MongoDB expenses
 *     description: Categories are exact budget names. Month filters UTC expense dates, while full budget limits remain unchanged. Remaining is budget minus actual; variance is actual minus budget.
 *     tags: [Budgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema:
 *           type: string
 *           example: '2024-02'
 *         description: Optional YYYY-MM expense month; omitted for all dates.
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Optional exact budget name; omitted for all budgets.
 *     responses:
 *       200:
 *         description: Summary and per-budget metrics, category options, and selected filters. Empty results have zero totals.
 *       400:
 *         description: Invalid month or category filter.
 *       401:
 *         description: Missing or invalid authentication.
 *       500:
 *         description: Unable to read analysis data.
 */
// Existing budgets represent spending categories; do not introduce a second taxonomy.
exports.getBudgetAnalysis = async (req, res, next) => {
  const { month, category } = req.query;
  if (month !== undefined && (typeof month !== 'string' || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month))) {
    return res.status(400).json({ error: 'month must be YYYY-MM (year 0001–9999)' });
  }
  if (category !== undefined && (typeof category !== 'string' || !category.trim() || category.length > 200)) {
    return res.status(400).json({ error: 'category must be a nonempty budget name (up to 200 characters)' });
  }

  try {
    const budgets = await Budget.find({ ...approvedBudgets, ...(category === undefined ? {} : { name: category }) })
      .sort({ name: 1, _id: 1 })
      .lean();
    const match = { budgetId: { $in: budgets.map(budget => budget._id) } };
    if (month) {
      const start = new Date(`${month}-01T00:00:00.000Z`);
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      match.createdAt = { $gte: start, $lt: end };
    }
    // Sum in decimal space before converting to currency minor units.
    const totals = budgets.length
      ? await Expense.aggregate([{ $match: match }, { $group: { _id: '$budgetId', actual: { $sum: { $toDecimal: '$amount' } }, expenseCount: { $sum: 1 } } }])
      : [];
    const byBudget = new Map(totals.map(total => [String(total._id), total]));
    const minorUnits = value => Math.round((Number(value) + Number.EPSILON) * 100);
    const rows = budgets.map(budget => {
      const total = byBudget.get(String(budget._id));
      const planned = minorUnits(budget.limit);
      const actual = minorUnits(total ? total.actual.toString() : 0);
      return {
        budgetId: String(budget._id),
        category: budget.name,
        budget: planned / 100,
        actual: actual / 100,
        remaining: (planned - actual) / 100,
        variance: (actual - planned) / 100,
        expenseCount: total ? total.expenseCount : 0,
      };
    });
    const summary = rows.reduce(
      (sum, row) => {
        for (const key of ['budget', 'actual', 'remaining', 'variance']) sum[key] += minorUnits(row[key]);
        sum.expenseCount += row.expenseCount;
        return sum;
      },
      { budget: 0, actual: 0, remaining: 0, variance: 0, expenseCount: 0 }
    );
    for (const key of ['budget', 'actual', 'remaining', 'variance']) summary[key] /= 100;
    // Return all categories so changing a filter never removes other options.
    const categories = await Budget.distinct('name', approvedBudgets);
    res.json({ month: month || null, category: category || null, categories: categories.sort(), summary, budgets: rows });
  } catch (error) {
    next(error);
  }
};
