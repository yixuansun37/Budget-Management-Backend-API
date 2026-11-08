const { createHash, randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/config');

exports.generateToken = userId => {
  return jwt.sign({ userId }, config.jwtSecret, { expiresIn: '48h', jwtid: randomUUID() });
};

exports.verifyToken = token => {
  return jwt.verify(token, config.jwtSecret);
};

// Never store raw bearer tokens in Redis keys.
exports.tokenBlacklistKey = (token, userId) => `blacklist:${userId}:${createHash('sha256').update(token).digest('hex')}`;
