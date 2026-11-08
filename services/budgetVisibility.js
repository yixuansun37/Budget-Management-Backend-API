// Approval requests must never leak through shared legacy read APIs.
exports.approvedBudgets = { $or: [{ requester: { $exists: false } }, { approvalStatus: 'FINAL_APPROVED' }] };
exports.publicBudgetFields = '-requester -assignedManager -history -approvalThreshold -financeRequired';
