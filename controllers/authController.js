const User = require('../models/user');
const { generateToken, verifyToken: verifyJwtToken, tokenBlacklistKey } = require('../services/jwtService');
const redisClient = require('../services/redisService');

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication and User Management
 */

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - email
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *                 description: The user's username.
 *               email:
 *                 type: string
 *                 description: The user's email address.
 *               password:
 *                 type: string
 *                 format: password
 *                 description: The user's password.
 *     responses:
 *       201:
 *         description: User registered successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: User registered successfully
 *                 token:
 *                   type: string
 *                   description: JWT for the newly created session (auto-login).
 *                   example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *       400:
 *         description: Email already in use.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Email already in use
 */
exports.register = async (req, res, next) => {
  try {
    const { username, email, password } = req.body || {};

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    // Create new user
    const user = new User({ username, email, password });
    await user.save();

    // Auto-login so the client can immediately offer passkey enrolment.
    const token = generateToken(user._id);

    res.status(201).json({ message: 'User registered successfully', token });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Authenticate a user and return a JWT
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 description: The user's email address.
 *               password:
 *                 type: string
 *                 format: password
 *                 description: The user's password.
 *     responses:
 *       200:
 *         description: Login successful.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Login successful
 *                 token:
 *                   type: string
 *                   description: JWT token for the authenticated user.
 *                   example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *       401:
 *         description: Invalid email or password.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Invalid email or password
 */
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    // Find user by email
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT token
    const token = generateToken(user._id);

    res.status(200).json({ message: 'Login successful', token });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logout the authenticated session and invalidate its token
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logout successful.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Logout successful. Current token invalidated."
 *       404:
 *         description: User not found.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "User not found."
 *       500:
 *         description: Server error.
 */
exports.logout = async (req, res, next) => {
  try {
    // The authenticated identity is authoritative; ignore body-supplied email/IDs.
    const blacklistKey = tokenBlacklistKey(req.authToken, req.user.userId);
    const tokenExpiry = Math.max(1, req.user.exp - Math.floor(Date.now() / 1000));
    await redisClient.set(blacklistKey, 'true', { EX: tokenExpiry });
    res.status(200).json({ message: 'Logout successful. Current token invalidated.' });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/auth/verify-email:
 *   post:
 *     summary: Verify if an email is registered
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 description: The email to verify.
 *     responses:
 *       200:
 *         description: Email verified successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 exists:
 *                   type: boolean
 *                   example: true
 *       404:
 *         description: Email not found.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Email not found
 */
exports.verifyEmail = async (req, res, next) => {
  try {
    const { email } = req.body || {};

    const user = await User.findOne({ email });
    if (user) {
      return res.status(200).json({ exists: true });
    }

    res.status(404).json({ error: 'Email not found' });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/auth/reset-password:
 *   post:
 *     summary: Password recovery is disabled until verified recovery is configured
 *     tags: [Auth]
 *     responses:
 *       501:
 *         description: Secure password recovery is not configured; no password is changed.
 */
exports.resetPassword = async (_req, res) => {
  // The legacy endpoint accepted an email alone, enabling takeover of privileged accounts.
  // A verified, single-use recovery token flow must exist before password reset is enabled.
  res.status(501).json({ error: 'Secure password recovery is not configured. Password reset is disabled.' });
};

/**
 * @swagger
 * /api/auth/verify-token:
 *   post:
 *     summary: Verify if a token is valid
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *             properties:
 *               token:
 *                 type: string
 *                 description: The JWT to verify.
 *     responses:
 *       200:
 *         description: Token is valid.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                   example: true
 *       401:
 *         description: Token is invalid or expired.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Token is invalid or expired
 */
exports.verifyToken = async (req, res, next) => {
  const { token } = req.body || {};
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'Token is required' });
  }
  let decoded;
  try {
    decoded = verifyJwtToken(token);
    if (!decoded || typeof decoded.userId !== 'string' || !decoded.userId.trim() || !Number.isInteger(decoded.exp)) {
      return res.status(401).json({ error: 'Token is invalid or expired' });
    }
  } catch (_error) {
    return res.status(401).json({ error: 'Token is invalid or expired' });
  }
  try {
    if (await redisClient.get(tokenBlacklistKey(token, decoded.userId))) {
      return res.status(401).json({ error: 'Token is invalid or expired' });
    }
    res.status(200).json({ valid: true });
  } catch (error) {
    next(error);
  }
};
