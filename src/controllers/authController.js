import { db } from '../config/db.js';
import { hashPassword, comparePassword } from '../utils/hash.js';
import { generateToken } from '../utils/jwt.js';
import { asyncHandler } from '../middleware/error.js';

export const register = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  }

  // Check if user exists
  const existingUser = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existingUser.length > 0) {
    return res.status(409).json({ message: 'User already exists' });
  }

  // Hash password and create user
  const passwordHash = await hashPassword(password);
  const result = await db.query(
    'INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)',
    [email, passwordHash, false]
  );

  const token = generateToken({ userId: result.insertId, email, isAdmin: false });

  res.status(201).json({
    message: 'User registered successfully',
    token,
    user: { id: result.insertId, email, is_admin: false },
  });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  // Find user
  const users = await db.query('SELECT id, email, password_hash, is_admin FROM users WHERE email = ?', [email]);
  if (users.length === 0) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const user = users[0];

  // Verify password
  const isValid = await comparePassword(password, user.password_hash);
  if (!isValid) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const token = generateToken({ userId: user.id, email: user.email, isAdmin: user.is_admin });

  res.json({
    message: 'Login successful',
    token,
    user: { id: user.id, email: user.email, is_admin: user.is_admin },
  });
});

export const getMe = asyncHandler(async (req, res) => {
  const users = await db.query('SELECT id, email, created_at, is_admin FROM users WHERE id = ?', [req.user.userId]);
  
  if (users.length === 0) {
    return res.status(404).json({ message: 'User not found' });
  }

  res.json({ user: users[0] });
});

export const logout = asyncHandler(async (req, res) => {
  // Client-side token removal
  res.json({ message: 'Logged out successfully' });
});
