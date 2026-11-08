const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const Budget = require('./models/budget');
const Expense = require('./models/expense');
const authenticate = require('./middleware/authMiddleware');
const authorize = require('./middleware/authorize');
const { approvedBudgets } = require('./services/budgetVisibility');

// Load gRPC Proto
const PROTO_PATH = path.join(__dirname, 'proto/budget.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const budgetProto = grpc.loadPackageDefinition(packageDefinition).budget;

const mapBudget = budget => ({
  budgetId: budget._id.toString(),
  name: budget.name,
  limit: budget.limit,
  createdAt: budget.createdAt.toISOString(),
});

const mapExpense = expense => ({
  expenseId: expense._id.toString(),
  budgetId: expense.budgetId.toString(),
  description: expense.description,
  amount: expense.amount,
  createdAt: expense.createdAt.toISOString(),
});

// Implement BudgetManager Service
const budgetManager = {
  // Get a Budget
  GetBudget: async (call, callback) => {
    try {
      const { budgetId } = call.request;
      const budget = await Budget.findOne({ _id: budgetId, ...approvedBudgets });
      if (!budget) {
        return callback(new Error('Budget not found'), null);
      }
      callback(null, mapBudget(budget));
    } catch (error) {
      callback(error, null);
    }
  },

  // List Budgets
  ListBudgets: async (call, callback) => {
    try {
      const { page = 1, pageSize = 20, nameContains, minLimit, maxLimit } = call.request;
      const safePageSize = Math.min(Math.max(pageSize, 1), 100);
      const safePage = Math.max(page, 1);

      const query = { ...approvedBudgets };
      if (nameContains) {
        query.name = { $regex: nameContains, $options: 'i' };
      }
      if (minLimit || maxLimit) {
        query.limit = {};
        if (minLimit) query.limit.$gte = minLimit;
        if (maxLimit) query.limit.$lte = maxLimit;
      }

      const totalCount = await Budget.countDocuments(query);
      const budgets = await Budget.find(query)
        .sort({ createdAt: -1 })
        .skip((safePage - 1) * safePageSize)
        .limit(safePageSize);

      callback(null, {
        budgets: budgets.map(mapBudget),
        page: safePage,
        pageSize: safePageSize,
        totalCount,
      });
    } catch (error) {
      callback(error, null);
    }
  },

  // Create a Budget
  CreateBudget: async (call, callback) => {
    try {
      const { name, limit } = call.request;
      const budget = new Budget({ name, limit });
      const savedBudget = await budget.save();
      callback(null, { budgetId: savedBudget._id.toString() });
    } catch (error) {
      callback(error, null);
    }
  },

  // Update a Budget
  UpdateBudget: async (call, callback) => {
    try {
      const { budgetId, name, limit } = call.request;
      const update = {};
      if (name) update.name = name;
      if (limit > 0) update.limit = limit;

      const updatedBudget = await Budget.findOneAndUpdate({ _id: budgetId, requester: { $exists: false } }, update, { new: true, runValidators: true });
      if (!updatedBudget) {
        return callback(new Error('Budget not found'), null);
      }
      callback(null, { budget: mapBudget(updatedBudget) });
    } catch (error) {
      callback(error, null);
    }
  },

  // Delete a Budget
  DeleteBudget: async (call, callback) => {
    try {
      const { budgetId } = call.request;
      const deletedBudget = await Budget.findOneAndDelete({ _id: budgetId, requester: { $exists: false } });
      if (!deletedBudget) {
        return callback(new Error('Budget not found'), null);
      }
      await Expense.deleteMany({ budgetId });
      callback(null, { deleted: true });
    } catch (error) {
      callback(error, null);
    }
  },

  // Add an Expense
  AddExpense: async (call, callback) => {
    try {
      const { budgetId, description, amount } = call.request;
      const budget = await Budget.findOne({ _id: budgetId, ...approvedBudgets });
      if (!budget) {
        return callback(new Error('Budget not found'), null);
      }
      const expense = new Expense({ budgetId, description, amount });
      const savedExpense = await expense.save();
      callback(null, { expenseId: savedExpense._id.toString() });
    } catch (error) {
      callback(error, null);
    }
  },

  // Get Expenses for a Budget
  GetExpenses: async (call, callback) => {
    try {
      const { budgetId, limit = 100, offset = 0 } = call.request;
      const safeLimit = Math.min(Math.max(limit, 1), 200);
      const safeOffset = Math.max(offset, 0);
      const budget = await Budget.findOne({ _id: budgetId, ...approvedBudgets }).select('_id');
      if (!budget) return callback(new Error('Budget not found'), null);
      const expenses = await Expense.find({ budgetId }).sort({ createdAt: -1 }).skip(safeOffset).limit(safeLimit);
      if (!expenses.length) {
        return callback(new Error('No expenses found for this budget'), null);
      }
      callback(null, {
        expenses: expenses.map(mapExpense),
      });
    } catch (error) {
      callback(error, null);
    }
  },

  // Stream Expenses for a Budget
  StreamExpenses: async call => {
    try {
      const { budgetId, limit = 0 } = call.request;
      const budget = await Budget.findOne({ _id: budgetId, ...approvedBudgets }).select('_id');
      if (!budget) throw new Error('Budget not found');
      const query = Expense.find({ budgetId }).sort({ createdAt: -1 });
      if (limit > 0) query.limit(limit);
      const expenses = await query;
      expenses.forEach(exp => call.write(mapExpense(exp)));
      call.end();
    } catch (error) {
      call.destroy(error);
    }
  },

  // Get Budget Summary
  GetBudgetSummary: async (call, callback) => {
    try {
      const { budgetId } = call.request;
      const budget = await Budget.findOne({ _id: budgetId, ...approvedBudgets });
      if (!budget) {
        return callback(new Error('Budget not found'), null);
      }

      const [{ total = 0, count = 0 } = {}] = await Expense.aggregate([
        { $match: { budgetId: budget._id } },
        {
          $group: {
            _id: '$budgetId',
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]);

      callback(null, {
        summary: {
          budgetId: budget._id.toString(),
          name: budget.name,
          limit: budget.limit,
          spent: total,
          remaining: Math.max(budget.limit - total, 0),
          expenseCount: count,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      callback(error, null);
    }
  },
};

// Apply the same JWT revocation and database-backed authority checks as REST.
const runMiddleware = (middleware, req) =>
  new Promise((resolve, reject) => {
    const res = {
      status(statusCode) {
        this.statusCode = statusCode;
        return this;
      },
      json(body) {
        reject(Object.assign(new Error(body.error), { statusCode: this.statusCode }));
      },
    };
    Promise.resolve(middleware(req, res, error => (error ? reject(error) : resolve()))).catch(reject);
  });
const protectedBudgetManager = Object.fromEntries(
  Object.entries(budgetManager).map(([name, handler]) => [
    name,
    async (call, callback) => {
      try {
        const values = call.metadata?.get('authorization') || [];
        const req = { headers: { authorization: values.length === 1 ? String(values[0]) : undefined } };
        await runMiddleware(authenticate, req);
        const roles = ['CreateBudget', 'UpdateBudget', 'DeleteBudget'].includes(name) ? ['finance_admin'] : [];
        await runMiddleware(authorize(...roles), req);
        await handler(call, callback);
      } catch (error) {
        const denied = Object.assign(new Error(error.statusCode ? error.message : 'Unable to process request'), {
          code: error.statusCode === 401 ? grpc.status.UNAUTHENTICATED : error.statusCode === 403 ? grpc.status.PERMISSION_DENIED : grpc.status.INTERNAL,
        });
        if (callback) callback(denied, null);
        else call.destroy(denied);
      }
    },
  ])
);

// Start gRPC Server
const startGrpcServer = () => {
  const server = new grpc.Server();
  server.addService(budgetProto.BudgetManager.service, protectedBudgetManager);
  const PORT = process.env.GRPC_PORT || 50051;
  server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      console.error('Error starting gRPC server:', err);
      process.exit(1);
    }
    console.log(`gRPC Server running at http://0.0.0.0:${port}`);
    server.start();
  });
};

module.exports = startGrpcServer;

module.exports.handlers = protectedBudgetManager;
