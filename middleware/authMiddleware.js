const { verifyToken, tokenBlacklistKey } = require('../services/jwtService');
const redisClient = require('../services/redisService');

const authenticate = async (req, res, next) => {
  try {
    const authorization = req.headers.authorization;
    const token = typeof authorization === 'string' && /^Bearer [^\s]+$/i.test(authorization) ? authorization.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: Token missing' });
    }

    // Decode the token
    const decoded = verifyToken(token);
    if (!decoded || typeof decoded.userId !== 'string' || !decoded.userId.trim() || !Number.isInteger(decoded.exp)) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token identity' });
    }

    // Check if the user's tokens are blacklisted
    const blacklistKey = tokenBlacklistKey(token, decoded.userId);
    const isBlacklisted = await redisClient.get(blacklistKey);

    if (isBlacklisted) {
      return res.status(401).json({ error: 'Unauthorized: Token invalidated. Please login again.' });
    }

    req.user = decoded;
    req.authToken = token;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

module.exports = authenticate;
