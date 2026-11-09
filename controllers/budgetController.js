const Budget = require('../models/budget');
const { approvedBudgets, publicBudgetFields } = require('../services/budgetVisibility');
const redisClient = require('../services/redisService');
const mongoose = require('mongoose');
const { publishEvent } = require('../apache-kafka/kafkaService');
const { event: auditEvent } = require('../services/auditService');

const publicBudget = document => {
  const value = document.toObject ? document.toObject() : { ...document };
  for (const key of [
    'auditTrail',
    'deletedAt',
    'requester',
    'assignedManager',
    'history',
    'approvalThreshold',
    'financeRequired',
    'requestKey',
    'requestFingerprint',
  ])
    delete value[key];
  return value;
};
// The database action and audit entry have already committed together. Optional
// cache/event failures must not make callers retry a successful business write.
const secondary = async operation => {
  try {
    await operation();
  } catch (_) {
    console.warn('Budget cache/event delivery unavailable after database commit');
  }
};

/**
 * @swagger
 * tags:
 *   name: Budgets
 *   description: Budget Management API
 */

/**
 * @swagger
 * /api/budgets:
 *   post:
 *     summary: Create a new budget
 *     tags: [Budgets]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - limit
 *             properties:
 *               name:
 *                 type: string
 *                 description: The name of the budget.
 *               limit:
 *                 type: number
 *                 description: The spending limit of the budget.
 *     responses:
 *       201:
 *         description: Budget created successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Budget created
 *                 budget:
 *                   type: object
 *                   properties:
 *                     _id:
 *                       type: string
 *                       example: 64c9b5f4e7a7d2b001e76a1b
 *                     name:
 *                       type: string
 *                       example: Travel
 *                     limit:
 *                       type: number
 *                       example: 2000
 *       500:
 *         description: Server error.
 */
exports.createBudget = async (req, res, next) => {
  try {
    const { name, limit } = req.body;
    const budget = new Budget({ name, limit });
    budget.auditTrail = [auditEvent('BUDGET_CREATED', req.principal, null, budget, budget._id)];
    const savedBudget = await budget.save();
    const safeBudget = publicBudget(savedBudget);

    // Cache the budget in Redis
    await secondary(() => redisClient.set(`budget:${savedBudget._id}`, JSON.stringify(safeBudget)));

    await secondary(() =>
      publishEvent(
        'budget-events',
        'budget.created',
        {
          budgetId: savedBudget._id.toString(),
          name: savedBudget.name,
          limit: savedBudget.limit,
        },
        { key: savedBudget._id.toString(), source: 'budget-controller' }
      )
    );

    res.status(201).json({ message: 'Budget created', budget: safeBudget });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/budgets/{id}:
 *   get:
 *     summary: Get a budget by ID
 *     tags: [Budgets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the budget to retrieve.
 *     responses:
 *       200:
 *         description: Budget retrieved successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 budget:
 *                   type: object
 *                   properties:
 *                     _id:
 *                       type: string
 *                       example: 64c9b5f4e7a7d2b001e76a1b
 *                     name:
 *                       type: string
 *                       example: Travel
 *                     limit:
 *                       type: number
 *                       example: 2000
 *                 source:
 *                   type: string
 *                   example: cache
 *       404:
 *         description: Budget not found.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Budget not found
 *       500:
 *         description: Server error.
 */
exports.getBudget = async (req, res, next) => {
  const { id } = req.params;

  try {
    // Scope before responding; cached documents may contain private approval fields.
    const budget = await Budget.findOne({ _id: id, ...approvedBudgets }).select(publicBudgetFields);
    if (!budget) return res.status(404).json({ error: 'Budget not found' });

    res.status(200).json({ budget, source: 'database' });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/budgets:
 *   get:
 *     summary: Get all budgets
 *     tags: [Budgets]
 *     responses:
 *       200:
 *         description: List of all budgets.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   _id:
 *                     type: string
 *                     example: 64c9b5f4e7a7d2b001e76a1b
 *                   name:
 *                     type: string
 *                     example: Travel
 *                   limit:
 *                     type: number
 *                     example: 2000
 *       500:
 *         description: Server error.
 */
exports.getAllBudgets = async (req, res, next) => {
  try {
    const budgets = await Budget.find(approvedBudgets).select(publicBudgetFields);
    res.status(200).json(budgets);
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/budgets/{id}:
 *   delete:
 *     summary: Delete a budget by ID
 *     tags: [Budgets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the budget to delete.
 *     responses:
 *       200:
 *         description: Budget deleted successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Budget deleted successfully.
 *       404:
 *         description: Budget not found.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Budget not found
 *       500:
 *         description: Server error.
 */
exports.deleteBudget = async (req, res, next) => {
  const { id } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid budget ID format' });
    const before = await Budget.findOne({ _id: id, requester: { $exists: false }, deletedAt: { $exists: false } });
    if (!before) {
      return res.status(404).json({ error: 'Budget not found' });
    }
    const deletedAt = new Date();
    const deletedBudget = await Budget.findOneAndUpdate(
      { _id: id, requester: { $exists: false }, deletedAt: { $exists: false }, __v: before.__v },
      {
        $set: { deletedAt },
        $inc: { __v: 1 },
        $push: { auditTrail: auditEvent('BUDGET_DELETED', req.principal, before, { ...before.toObject(), deletedAt }, before._id) },
      },
      { new: true, runValidators: true }
    );
    if (!deletedBudget) return res.status(409).json({ error: 'Budget changed. Refresh before acting again.' });

    // Remove from Redis cache
    await secondary(() => redisClient.del(`budget:${id}`));

    await secondary(() =>
      publishEvent(
        'budget-events',
        'budget.deleted',
        { budgetId: id, name: deletedBudget.name, limit: deletedBudget.limit },
        { key: id, source: 'budget-controller' }
      )
    );

    res.status(200).json({ message: 'Budget deleted successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/budgets/{id}:
 *   put:
 *     summary: Update a budget by ID
 *     tags: [Budgets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the budget to update.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: The updated name of the budget.
 *                 example: "Updated Travel Budget"
 *               limit:
 *                 type: number
 *                 description: The updated spending limit of the budget.
 *                 example: 2500
 *     responses:
 *       200:
 *         description: Budget updated successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Budget updated successfully.
 *                 budget:
 *                   type: object
 *       400:
 *         description: Validation error or invalid ID format.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Validation error.
 *                 details:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example:
 *                     - "Limit must be a number."
 *       404:
 *         description: Budget not found.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Budget not found.
 *       500:
 *         description: Server error.
 */
exports.updateBudget = async (req, res, next) => {
  const { id } = req.params;
  const { name, limit } = req.body;

  try {
    // Validate ID format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid budget ID format' });
    }

    const before = await Budget.findOne({ _id: id, requester: { $exists: false }, deletedAt: { $exists: false } });
    if (!before) {
      return res.status(404).json({ error: 'Budget not found' });
    }
    const values = { ...(name !== undefined && { name }), ...(limit !== undefined && { limit }) };
    const after = new Budget({ ...before.toObject(), ...values });
    await after.validate();
    const updatedBudget = await Budget.findOneAndUpdate(
      { _id: id, requester: { $exists: false }, deletedAt: { $exists: false }, __v: before.__v },
      {
        $set: { name: after.name, limit: after.limit },
        $inc: { __v: 1 },
        $push: { auditTrail: auditEvent('BUDGET_MODIFIED', req.principal, before, after, before._id) },
      },
      { new: true, runValidators: true }
    );
    if (!updatedBudget) return res.status(409).json({ error: 'Budget changed. Refresh before acting again.' });
    const safeBudget = publicBudget(updatedBudget);

    // Update Redis cache
    await secondary(() => redisClient.set(`budget:${id}`, JSON.stringify(safeBudget)));

    await secondary(() =>
      publishEvent(
        'budget-events',
        'budget.updated',
        {
          budgetId: updatedBudget._id.toString(),
          name: updatedBudget.name,
          limit: updatedBudget.limit,
        },
        { key: updatedBudget._id.toString(), source: 'budget-controller' }
      )
    );

    res.status(200).json({ message: 'Budget updated successfully', budget: safeBudget });
  } catch (error) {
    // Handle validation errors
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        error: 'Validation error',
        details: Object.values(error.errors).map(err => err.message),
      });
    }

    console.error('Error updating budget:', error);
    next(error);
  }
};
