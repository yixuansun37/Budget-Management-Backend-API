const service = require('../services/budgetApprovalService');
const User = require('../models/user');
const { getApprovalPolicy } = require('../config/approvalPolicy');
const clean = request => {
  const { requestKey, requestFingerprint, auditTrail, ...safe } = request;
  return safe;
};
const handle = fn => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};
exports.list = handle(async (req, res) =>
  res.json({ requests: (await service.list(req.principal, req.query.view)).map(clean), policy: getApprovalPolicy(), role: req.principal.role })
);
exports.reviewers = handle(async (req, res) =>
  res.json({ managers: await User.find({ role: 'manager' }).select('_id username').sort({ username: 1 }).lean() })
);
exports.get = handle(async (req, res) => res.json({ request: clean(await service.get(req.params.id, req.principal)) }));
exports.create = handle(async (req, res) => {
  const result = await service.create(req.body || {}, req.principal);
  res.status(result.created ? 201 : 200).json({ request: clean(result.request) });
});
exports.edit = handle(async (req, res) => res.json({ request: clean(await service.edit(req.params.id, req.body || {}, req.principal)) }));
exports.transition = action =>
  handle(async (req, res) => res.json({ request: clean(await service.transition(req.params.id, action, req.body || {}, req.principal)) }));
