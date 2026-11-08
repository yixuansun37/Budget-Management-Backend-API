const { GraphQLObjectType, GraphQLSchema, GraphQLString, GraphQLList, GraphQLID, GraphQLInt } = require('graphql');
const Budget = require('../models/budget');
const { approvedBudgets, publicBudgetFields } = require('../services/budgetVisibility');
const Expense = require('../models/expense');

const BudgetType = new GraphQLObjectType({
  name: 'Budget',
  fields: {
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    limit: { type: GraphQLInt },
    createdAt: { type: GraphQLString },
  },
});

const ExpenseType = new GraphQLObjectType({
  name: 'Expense',
  fields: {
    id: { type: GraphQLID },
    description: { type: GraphQLString },
    amount: { type: GraphQLInt },
    budgetId: { type: GraphQLID },
    createdAt: { type: GraphQLString },
  },
});

const RootQuery = new GraphQLObjectType({
  name: 'RootQueryType',
  fields: {
    budgets: {
      type: new GraphQLList(BudgetType),
      resolve: () => Budget.find(approvedBudgets).select(publicBudgetFields),
    },
    expenses: {
      type: new GraphQLList(ExpenseType),
      args: { budgetId: { type: GraphQLID } },
      resolve: async (_, { budgetId }) => {
        if (!budgetId) return [];
        const budget = await Budget.findOne({ _id: budgetId, ...approvedBudgets }).select('_id');
        return budget ? Expense.find({ budgetId: budget._id }) : [];
      },
    },
  },
});

module.exports = new GraphQLSchema({ query: RootQuery });
