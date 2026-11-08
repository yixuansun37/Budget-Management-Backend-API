exports.getApprovalPolicy = () => {
  const raw = process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD;
  // Conservative default: every request requires Finance review. No company policy assumed.
  const financeApprovalThreshold = raw === undefined ? 0 : Number(raw);
  if (
    (raw !== undefined && !raw.trim()) ||
    !Number.isFinite(financeApprovalThreshold) ||
    financeApprovalThreshold < 0 ||
    financeApprovalThreshold > Number.MAX_SAFE_INTEGER / 100 ||
    Math.abs(financeApprovalThreshold * 100 - Math.round(financeApprovalThreshold * 100)) > 0.000001
  ) {
    const error = new Error('Invalid BUDGET_FINANCE_APPROVAL_THRESHOLD configuration');
    error.status = 503;
    throw error;
  }
  return { financeApprovalThreshold };
};
