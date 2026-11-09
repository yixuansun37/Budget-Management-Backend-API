const crypto = require('crypto');
const mongoose = require('mongoose');
const Budget = require('../models/budget');
const User = require('../models/user');
const { getApprovalPolicy } = require('../config/approvalPolicy');
const audit = require('./auditService');

const fail = (status, message) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};
const id = value => String(value);
const entry = (status, principal, comment = '') => ({
  status,
  actor: principal ? principal._id : null,
  role: principal ? principal.role : 'system',
  at: new Date(),
  comment,
});
const own = (request, principal) => id(request.requester) === id(principal._id);
const scope = principal =>
  principal.role === 'finance_admin'
    ? { requester: { $exists: true } }
    : principal.role === 'manager'
      ? { assignedManager: principal._id, approvalStatus: { $ne: 'DRAFT' } }
      : { requester: principal._id };

const fields = async body => {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 200) fail(400, 'Name must contain 1–200 characters');
  if (
    typeof body.limit !== 'number' ||
    !Number.isFinite(body.limit) ||
    body.limit <= 0 ||
    body.limit > Number.MAX_SAFE_INTEGER / 100 ||
    Math.abs(body.limit * 100 - Math.round(body.limit * 100)) > 0.000001
  )
    fail(400, 'Amount must be positive with at most two decimal places');
  if (!mongoose.isValidObjectId(body.assignedManager)) fail(400, 'Select a valid manager');
  const manager = await User.findOne({ _id: body.assignedManager, role: 'manager' }).lean();
  if (!manager) fail(400, 'Assigned reviewer must be an existing manager');
  return { name: body.name.trim(), limit: body.limit, assignedManager: manager._id };
};
const get = async (requestId, principal) => {
  if (!mongoose.isValidObjectId(requestId)) fail(400, 'Invalid request ID');
  const request = await Budget.findOne({ _id: requestId, ...scope(principal) }).lean();
  if (!request) fail(404, 'Request not found');
  return request;
};
const update = async (request, body, changes, history) => {
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) fail(400, 'expectedVersion is required');
  if (body.expectedVersion !== request.__v) fail(409, 'Request changed. Refresh before acting again.');
  let before = request;
  const auditTrail = history.map(step => {
    const after = { ...before, ...changes, approvalStatus: step.status };
    const action = step.status === 'DRAFT' ? 'BUDGET_MODIFIED' : step.status === 'SUBMITTED' ? 'BUDGET_SUBMITTED'
      : step.status === 'REJECTED' ? 'BUDGET_REJECTED' : 'BUDGET_APPROVED';
    const record = audit.event(action, step.actor ? { _id: step.actor, role: step.role } : null, before, after, request._id, step.at);
    before = after;
    return record;
  });
  const changed = await Budget.findOneAndUpdate(
    { _id: request._id, __v: request.__v, approvalStatus: request.approvalStatus },
    { $set: changes, $push: { history: { $each: history }, auditTrail: { $each: auditTrail } }, $inc: { __v: 1 } },
    { new: true, runValidators: true }
  ).lean();
  if (!changed) fail(409, 'Request changed. Refresh before acting again.');
  return changed;
};

exports.get = get;
exports.list = async (principal, view = 'mine') => {
  if (!['mine', 'pending', 'history'].includes(view)) fail(400, 'Invalid request view');
  let query = view === 'mine' ? { requester: principal._id } : scope(principal);
  if (view === 'pending') {
    if (principal.role === 'employee') fail(403, 'Review permission required');
    query =
      principal.role === 'manager'
        ? { assignedManager: principal._id, approvalStatus: 'SUBMITTED' }
        : { requester: { $exists: true }, approvalStatus: { $in: ['MANAGER_APPROVED', 'FINANCE_APPROVED'] } };
    query.requester = { $exists: true, $ne: principal._id };
  }
  return Budget.find(query).sort({ createdAt: -1 }).lean();
};
exports.create = async (body, principal) => {
  // Do not accept creates before the idempotency index is ready.
  await Budget.init();
  if (typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(body.requestKey))
    fail(400, 'A stable requestKey (16–100 letters, numbers or hyphens) is required');
  const values = await fields(body);
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({ ...values, assignedManager: id(values.assignedManager) }))
    .digest('hex');
  const lookup = { requester: principal._id, requestKey: body.requestKey };
  const existing = async () => {
    const request = await Budget.findOne(lookup).select('+requestFingerprint').lean();
    if (request && request.requestFingerprint !== fingerprint) fail(409, 'requestKey was already used for different request data');
    return request;
  };
  const previous = await existing();
  if (previous) return { request: previous, created: false };
  try {
    const requestId = new mongoose.Types.ObjectId();
    const request = await Budget.create({
      _id: requestId,
      ...values,
      ...lookup,
      requestFingerprint: fingerprint,
      approvalStatus: 'DRAFT',
      history: [entry('DRAFT', principal)],
      auditTrail: [audit.event('BUDGET_CREATED', principal, null, { ...values, approvalStatus: 'DRAFT' }, requestId)],
    });
    return { request: request.toObject(), created: true };
  } catch (error) {
    if (error.code !== 11000) throw error;
    const request = await existing();
    if (!request) throw error;
    return { request, created: false };
  }
};
exports.edit = async (requestId, body, principal) => {
  const request = await get(requestId, principal);
  if (!own(request, principal)) fail(403, 'Only the requester can edit a draft');
  if (request.approvalStatus !== 'DRAFT') fail(409, 'Only drafts can be edited');
  return update(request, body, await fields(body), [entry('DRAFT', principal, 'Draft updated')]);
};
exports.transition = async (requestId, action, body, principal) => {
  const request = await get(requestId, principal);
  if (typeof body.comment !== 'undefined' && typeof body.comment !== 'string') fail(400, 'Comment must be text');
  const comment = (body.comment || '').trim();
  if (comment.length > 2000) fail(400, 'Comment cannot exceed 2000 characters');
  if (action === 'submit') {
    if (principal.role !== 'employee' || !own(request, principal)) fail(403, 'Only the employee requester can submit');
    if (request.approvalStatus !== 'DRAFT') fail(409, 'Only drafts can be submitted');
    await fields(request); // Revalidate manager assignment when submitting.
    const { financeApprovalThreshold } = getApprovalPolicy();
    return update(
      request,
      body,
      { approvalStatus: 'SUBMITTED', approvalThreshold: financeApprovalThreshold, financeRequired: request.limit >= financeApprovalThreshold },
      [entry('SUBMITTED', principal, comment)]
    );
  }
  if (own(request, principal)) fail(403, 'You cannot approve or reject your own request');
  const managerTurn = principal.role === 'manager' && id(request.assignedManager) === id(principal._id) && request.approvalStatus === 'SUBMITTED';
  const financeTurn = principal.role === 'finance_admin' && request.financeRequired && request.approvalStatus === 'MANAGER_APPROVED';
  const finalTurn = principal.role === 'finance_admin' && request.approvalStatus === 'FINANCE_APPROVED';
  if (action === 'finalize') {
    if (!finalTurn) fail(409, 'Request is not ready for final approval');
    return update(request, body, { approvalStatus: 'FINAL_APPROVED' }, [entry('FINAL_APPROVED', principal, comment)]);
  }
  if (!managerTurn && !financeTurn && !(action === 'reject' && finalTurn)) fail(409, 'Request is not at your approval stage');
  if (action === 'reject') {
    if (!comment) fail(400, 'A rejection reason is required');
    return update(request, body, { approvalStatus: 'REJECTED' }, [entry('REJECTED', principal, comment)]);
  }
  const status = managerTurn ? 'MANAGER_APPROVED' : 'FINANCE_APPROVED';
  const history = [entry(status, principal, comment)];
  if (managerTurn && !request.financeRequired) {
    history.push(
      entry('FINANCE_APPROVED', null, 'Finance review waived by the submitted threshold policy'),
      entry('FINAL_APPROVED', null, 'Automatically finalized under the submitted threshold policy')
    );
  }
  return update(request, body, { approvalStatus: history[history.length - 1].status }, history);
};
