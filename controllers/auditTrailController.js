const audit = require('../services/auditService');

/**
 * @swagger
 * /api/audit-trail:
 *   get:
 *     summary: Read authorized budget audit events, newest first
 *     description: Scoped to own requests for Employees, assigned submitted requests for Managers, or all budgets for Finance Admins. Optional targetId, action, UTC date from/to, page, and pageSize (maximum 100) filters.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Records with actor, action, target, timestamp, before/after snapshots and pagination metadata.
 *       400:
 *         description: Invalid filters or pagination.
 *       401:
 *         description: Authentication or current account required.
 */
exports.list = async (req, res, next) => {
  try { res.json(await audit.list(req.principal, req.query)); }
  catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};
