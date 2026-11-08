#!/usr/bin/env node
// Operator-only bootstrap. Never called from an HTTP endpoint or public registration.
const mongoose = require('mongoose');
const User = require('../models/user');
const config = require('../config/config');

const [userId, role, ...extra] = process.argv.slice(2);
if (extra.length || !mongoose.isValidObjectId(userId) || !['employee', 'manager', 'finance_admin'].includes(role)) {
  console.error('Usage: node scripts/set-user-role.js <existing-user-id> <employee|manager|finance_admin>');
  process.exitCode = 1;
} else {
  (async () => {
    try {
      await mongoose.connect(config.mongoURI);
      const user = await User.findByIdAndUpdate(userId, { role }, { new: true, runValidators: true }).select('_id role');
      if (!user) throw new Error('User not found');
      console.log(`Role set for ${user._id}: ${user.role}`);
    } catch (error) {
      console.error('Role assignment failed:', error.message);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect();
    }
  })();
}
