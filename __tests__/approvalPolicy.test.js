const { getApprovalPolicy } = require('../config/approvalPolicy');
const original = process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD;
afterAll(() => {
  if (original === undefined) delete process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD;
  else process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD = original;
});
test('requires finance for every amount by default', () => {
  delete process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD;
  expect(getApprovalPolicy()).toEqual({ financeApprovalThreshold: 0 });
});
test.each(['', ' ', '-1', 'abc', 'Infinity', '1.001'])('fails closed for invalid threshold %j', value => {
  process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD = value;
  expect(() => getApprovalPolicy()).toThrow('Invalid BUDGET_FINANCE_APPROVAL_THRESHOLD');
});
test('accepts an explicit nonnegative monetary threshold', () => {
  process.env.BUDGET_FINANCE_APPROVAL_THRESHOLD = '100.01';
  expect(getApprovalPolicy()).toEqual({ financeApprovalThreshold: 100.01 });
});
