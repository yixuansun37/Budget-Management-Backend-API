const mongoose = require('mongoose');
const User = require('../models/user');

// Load current authority from the database, never from a JWT role or request body.
module.exports =
  (...roles) =>
  async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.user?.userId)) return res.status(401).json({ error: 'Account unavailable' });
      const user = await User.findById(req.user.userId).select('_id username role').lean();
      if (!user) return res.status(401).json({ error: 'Account unavailable' });
      const role = user.role || 'employee';
      if (!['employee', 'manager', 'finance_admin'].includes(role) || (roles.length && !roles.includes(role))) {
        return res.status(403).json({ error: 'Insufficient permission' });
      }
      req.principal = { ...user, role };
      next();
    } catch (error) {
      next(error);
    }
  };
