const express = require('express');
const bcrypt = require('bcrypt');
const validator = require('validator');
const db = require('../config/db');

const router = express.Router();

const COOKIE_NAME = 'wamator_api_key';
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// POST /session/login — set httpOnly cookie with API key
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const normalizedEmail = validator.normalizeEmail(email);

    const [rows] = await db.query(
      'SELECT id, name, company_name, phone_number, email, password_hash, api_key FROM api_consumer WHERE email = ?',
      [normalizedEmail]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const vendor = rows[0];

    const passwordMatch = await bcrypt.compare(password, vendor.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Set httpOnly cookie with the API key
    res.cookie(COOKIE_NAME, vendor.api_key, COOKIE_OPTIONS);

    // Return vendor info WITHOUT api_key
    return res.json({
      status: 'ok',
      vendor: {
        id: vendor.id,
        name: vendor.name,
        company_name: vendor.company_name,
        phone_number: vendor.phone_number,
        email: vendor.email,
      },
    });
  } catch (err) {
    console.error('Session login error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /session/me — check auth state, return current vendor profile
router.get('/me', async (req, res) => {
  try {
    const apiKey = req.cookies[COOKIE_NAME];

    if (!apiKey) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const [rows] = await db.query(
      'SELECT id, name, company_name, phone_number, email FROM api_consumer WHERE api_key = ?',
      [apiKey]
    );

    if (rows.length === 0) {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      return res.status(401).json({ message: 'Invalid session' });
    }

    return res.json({ status: 'ok', vendor: rows[0] });
  } catch (err) {
    console.error('Session check error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /session/logout — clear the httpOnly cookie
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  return res.json({ status: 'ok', message: 'Logged out' });
});

module.exports = router;
