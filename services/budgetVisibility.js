// Approval requests must never leak through shared legacy read APIs.
exports.approvedBudgets = { deletedAt: { $exists: false }, $or: [{ requester: { $exists: false } }, { approvalStatus: 'FINAL_APPROVED' }] };
exports.publicBudgetFields = '-requester -assignedManager -history -approvalThreshold -financeRequired -auditTrail -deletedAt';
