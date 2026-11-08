const mongoose = require('mongoose');

/**
 * @swagger
 * components:
 *   schemas:
 *     Budget:
 *       type: object
 *       required:
 *         - name
 *         - limit
 *       properties:
 *         _id:
 *           type: string
 *           description: The auto-generated ID of the budget.
 *           example: "64c9f8f2a73c2f001b3c68f4"
 *         name:
 *           type: string
 *           description: The name of the budget.
 *           example: "Travel Budget"
 *         limit:
 *           type: number
 *           description: The spending limit for the budget.
 *           example: 2000
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: The date and time when the budget was created.
 *           example: "2023-10-01T12:34:56.789Z"
 *       example:
 *         _id: "64c9f8f2a73c2f001b3c68f4"
 *         name: "Travel Budget"
 *         limit: 2000
 *         createdAt: "2023-10-01T12:34:56.789Z"
 */

const budgetSchema = new mongoose.Schema({
  name: { type: String, required: true },
  limit: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
  // Optional on legacy budgets. Request-backed budgets use the same persisted record.
  requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', immutable: true },
  assignedManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvalStatus: { type: String, enum: ['DRAFT', 'SUBMITTED', 'MANAGER_APPROVED', 'FINANCE_APPROVED', 'FINAL_APPROVED', 'REJECTED'] },
  approvalThreshold: Number,
  financeRequired: Boolean,
  requestKey: { type: String, immutable: true, select: false },
  requestFingerprint: { type: String, immutable: true, select: false },
  history: {
    type: [
      {
        _id: false,
        status: { type: String, required: true },
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        role: { type: String, required: true },
        at: { type: Date, required: true },
        comment: { type: String, default: '' },
      },
    ],
    default: undefined,
  },
});

budgetSchema.index({ requester: 1, requestKey: 1 }, { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } } });

module.exports = mongoose.model('Budget', budgetSchema);
