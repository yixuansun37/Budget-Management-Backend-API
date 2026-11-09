const mongoose = require('mongoose');
const Budget = require('../models/budget');
const actions = require('../config/auditActions');
const snapshotFields = ['name', 'limit', 'assignedManager', 'approvalStatus', 'approvalThreshold', 'financeRequired', 'deletedAt'];

// Never serialize arbitrary bodies, users, tokens, credentials or review comments.
const snapshot = value => value == null ? null : Object.fromEntries(snapshotFields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
exports.snapshot = snapshot;
exports.event = (action, principal, before, after, targetId, timestamp = new Date()) => ({
  _id: new mongoose.Types.ObjectId(), actorId: principal ? principal._id : null,
  actorRole: principal ? principal.role : 'system', action, targetId, timestamp,
  before: snapshot(before), after: snapshot(after),
});
const fail = message => { const error = new Error(message); error.status = 400; throw error; };
const day = value => {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) fail('Dates must be valid YYYY-MM-DD values');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('Dates must be valid YYYY-MM-DD values');
  return parsed;
};
const positiveInteger = (value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) fail('Pagination must use positive integers');
  return Number(value);
};
exports.list = async (principal, query) => {
  const page = positiveInteger(query.page, 1);
  const pageSize = positiveInteger(query.pageSize, 20);
  if (pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) fail('pageSize cannot exceed 100 and page must be within range');
  const scope = principal.role === 'finance_admin' ? {} : principal.role === 'manager'
    ? { assignedManager: principal._id, approvalStatus: { $ne: 'DRAFT' } }
    : { requester: principal._id };
  if (query.targetId !== undefined) {
    if (typeof query.targetId !== 'string' || !/^[a-f\d]{24}$/i.test(query.targetId)) fail('targetId must be a budget/request ObjectId');
    scope._id = new mongoose.Types.ObjectId(query.targetId);
  }
  const filter = {};
  if (query.action !== undefined) {
    if (typeof query.action !== 'string' || !actions.includes(query.action)) fail('Invalid audit action');
    filter['auditTrail.action'] = query.action;
  }
  if (query.from !== undefined || query.to !== undefined) {
    const from = query.from === undefined ? null : day(query.from);
    const to = query.to === undefined ? null : day(query.to);
    if (from && to && from > to) fail('from cannot be later than to');
    const range = {};
    if (from) range.$gte = from;
    if (to) { to.setUTCDate(to.getUTCDate() + 1); range.$lt = to; }
    filter['auditTrail.timestamp'] = range;
  }
  const [result] = await Budget.aggregate([
    { $match: scope }, { $unwind: '$auditTrail' }, { $match: filter },
    { $sort: { 'auditTrail.timestamp': -1, 'auditTrail._id': -1 } },
    { $facet: {
      records: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }, { $replaceRoot: { newRoot: '$auditTrail' } }],
      count: [{ $count: 'total' }],
    } },
  ]);
  const total = result?.count[0]?.total || 0;
  const records = (result?.records || []).map(record => ({
    _id: record._id, actorId: record.actorId, actorRole: record.actorRole,
    action: record.action, targetId: record.targetId, timestamp: record.timestamp,
    before: snapshot(record.before), after: snapshot(record.after),
  }));
  return { records, page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
};
