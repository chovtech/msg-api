const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const validator = require('validator');
const dotenv = require('dotenv');
const db = require('../config/db'); // your MySQL connection
const authVendor = require('../middleware/authVendor');
const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { name, company_name, email, phone_number, password } = req.body;

    if (!name || !email || !password || !company_name || !phone_number) {
      return res.status(400).json({ message: 'Name, Email, Company name, Phone number (whatsapp) and Password are required' });
    }

    const normalizedEmail = validator.normalizeEmail(email);
    const normalizedName = validator.trim(name);
    const normalizedCompanyName = validator.trim(company_name);
    const normalizedPhoneNumber = phone_number.replace(/\D/g, '');

    if (!normalizedEmail) {
      return res.status(400).json({ message: 'Invalid email address' });
    }

    if (!validator.isMobilePhone(normalizedPhoneNumber, 'any')) {
      return res.status(400).json({ message: 'Invalid phone number' });
    }

    const [existing] = await db.query('SELECT id FROM api_consumer WHERE email = ?', [normalizedEmail]);
    if (existing.length) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const api_key = crypto.randomBytes(32).toString('hex');

    const [result] = await db.query(
      'INSERT INTO api_consumer (name, company_name, phone_number, email, password_hash, api_key) VALUES (?, ?, ?, ?, ?, ?)',
      [normalizedName, normalizedCompanyName, normalizedPhoneNumber, normalizedEmail, password_hash, api_key]
    );

    return res.status(201).json({
      status: 'ok',
      message: 'Registered successfully',
      id: result.insertId,
      api_key
    });



  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

router.put('/update', authVendor, async (req, res) => {
  const { id, name, company_name, phone_number } = req.body;

  // 1. Validate ID
  if (!id || parseInt(id) !== req.vendor.id) {
    return res.status(403).json({ message: 'Unauthorized or missing/invalid ID' });
  }

  // 2. Validate input fields
  const updates = [];
  const values = [];

  if (name) {
    if (!validator.isLength(name.trim(), { min: 2 })) {
      return res.status(400).json({ message: 'Name must be at least 2 characters' });
    }
    updates.push('name = ?');
    values.push(validator.trim(name));
  }

  if (company_name) {
    if (!validator.isLength(company_name.trim(), { min: 2 })) {
      return res.status(400).json({ message: 'Company name must be at least 2 characters' });
    }
    updates.push('company_name = ?');
    values.push(validator.trim(company_name));
  }

  if (phone_number) {
    const cleaned = phone_number.replace(/\D/g, '');
    if (!validator.isMobilePhone(cleaned, 'any')) {
      return res.status(400).json({ message: 'Invalid phone number' });
    }
    updates.push('phone_number = ?');
    values.push(cleaned);
  }

  if (updates.length === 0) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  try {
    values.push(id); // Final value for WHERE clause

    const sql = `UPDATE api_consumer SET ${updates.join(', ')} WHERE id = ?`;
    await db.query(sql, values);

    return res.json({status: 'ok', message: 'Profile updated successfully' });
  } catch (err) {
    console.error('Update error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

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

    // Remove password hash from returned object
    delete vendor.password_hash;

    return res.json({ status: 'ok', vendor });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});





module.exports = router;
