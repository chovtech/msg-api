const express = require('express');
const validator = require('validator');
const db = require('../config/db');
const authVendor = require('../middleware/authVendor');
const router = express.Router();

router.post('/register', authVendor, async (req, res) => {
  try {
    const { name, company_name, email, external_user_id } = req.body;
    const api_consumer_id = req.apiConsumerId; // from middleware

    if (!name || !email || !company_name) {
      return res.status(400).json({ message: 'Name, Email, Company name are required' });
    }

    const normalizedEmail = validator.normalizeEmail(email);
    const normalizedName = validator.trim(name);
    const normalizedCompanyName = validator.trim(company_name);

    if (!normalizedEmail) {
      return res.status(400).json({ message: 'Invalid email address' });
    }

    // Optional: Prevent same email from being used by same vendor
    const [existing] = await db.query(
     'SELECT email FROM app_users WHERE email = ? AND api_consumer_id = ?',
     [normalizedEmail, api_consumer_id]

    );
    if (existing.length) {
      return res.status(409).json({ message: 'Email already registered for this user' });
    }

    const [result] = await db.query(
      `INSERT INTO app_users (api_consumer_id, external_user_id, name, company_name, email, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [api_consumer_id, external_user_id || null, normalizedName, normalizedCompanyName, normalizedEmail]
    );

    // Auto-assign Free Plan subscription (plan_id 7, duration_days=0 = no expiry)
    try {
      await db.query(
        `INSERT INTO subscriptions (app_user_id, plan_id, started_at, ends_at, status)
         VALUES (?, 7, NOW(), DATE_ADD(NOW(), INTERVAL 100 YEAR), 'active')`,
        [result.insertId]
      );
    } catch (subErr) {
      console.error('Failed to auto-assign Free Plan:', subErr.message);
    }

    return res.status(201).json({
      status: 'ok',
      message: 'User registered successfully',
      id: result.insertId,
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /users/list — Get all users for the vendor
router.get('/list', authVendor, async (req, res) => {
  try {
    const api_consumer_id = req.apiConsumerId;
    const [users] = await db.query(
      'SELECT id, name, company_name, email, external_user_id, created_at FROM app_users WHERE api_consumer_id = ?',
      [api_consumer_id]
    );

    return res.json({
      status: 'ok',
      total: users.length,
      users,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /users/:id — Get specific user details if they belong to the vendor
router.get('/:id', authVendor, async (req, res) => {
  try {
    const api_consumer_id = req.apiConsumerId;
    const userId = req.params.id;

    const [user] = await db.query(
      'SELECT id, name, company_name, email, external_user_id, created_at FROM app_users WHERE id = ? AND api_consumer_id = ?',
      [userId, api_consumer_id]
    );

    if (!user.length) {
      return res.status(404).json({ message: 'User not found or does not belong to your app' });
    }

    return res.json({
      status: 'ok',
      user: user[0],
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// PATCH /users/:id — Update user details
router.patch('/:id', authVendor, async (req, res) => {
  try {
    const api_consumer_id = req.apiConsumerId;
    const userId = req.params.id;
    const { name, company_name, email } = req.body;

    // Check if user exists and belongs to vendor
    const [userCheck] = await db.query(
      'SELECT id FROM app_users WHERE id = ? AND api_consumer_id = ?',
      [userId, api_consumer_id]
    );

    if (!userCheck.length) {
      return res.status(404).json({ message: 'User not found or does not belong to your app' });
    }

    const updates = [];
    const params = [];

    if (name) {
      updates.push('name = ?');
      params.push(validator.trim(name));
    }

    if (company_name) {
      updates.push('company_name = ?');
      params.push(validator.trim(company_name));
    }

    if (email) {
      const normalizedEmail = validator.normalizeEmail(email);
      if (!normalizedEmail) {
        return res.status(400).json({ message: 'Invalid email address' });
      }
      updates.push('email = ?');
      params.push(normalizedEmail);
    }

    if (!updates.length) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    params.push(userId, api_consumer_id);
    const updateQuery = `UPDATE app_users SET ${updates.join(', ')} WHERE id = ? AND api_consumer_id = ?`;

    await db.query(updateQuery, params);

    return res.json({ status: 'ok', message: 'User updated successfully' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// DELETE /users/:id — Delete user
router.delete('/:id', authVendor, async (req, res) => {
  try {
    const api_consumer_id = req.apiConsumerId;
    const userId = req.params.id;

    const [userCheck] = await db.query(
      'SELECT id FROM app_users WHERE id = ? AND api_consumer_id = ?',
      [userId, api_consumer_id]
    );

    if (!userCheck.length) {
      return res.status(404).json({ message: 'User not found or does not belong to your app' });
    }

    await db.query('DELETE FROM app_users WHERE id = ? AND api_consumer_id = ?', [userId, api_consumer_id]);

    return res.json({ status: 'ok', message: 'User deleted successfully' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /users/:id/ensure-subscription — Ensure user has at least a Free Plan subscription
router.post('/:id/ensure-subscription', authVendor, async (req, res) => {
  try {
    const api_consumer_id = req.apiConsumerId;
    const userId = req.params.id;

    // Verify user belongs to vendor
    const [user] = await db.query(
      'SELECT id FROM app_users WHERE id = ? AND api_consumer_id = ?',
      [userId, api_consumer_id]
    );
    if (!user.length) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if active subscription already exists
    const [existing] = await db.query(
      `SELECT id FROM subscriptions WHERE app_user_id = ? AND status = 'active' AND ends_at > NOW()`,
      [userId]
    );
    if (existing.length) {
      return res.json({ status: 'ok', message: 'Active subscription already exists' });
    }

    // Auto-assign Free Plan (plan_id 7)
    await db.query(
      `INSERT INTO subscriptions (app_user_id, plan_id, started_at, ends_at, status)
       VALUES (?, 7, NOW(), DATE_ADD(NOW(), INTERVAL 100 YEAR), 'active')`,
      [userId]
    );

    return res.status(201).json({ status: 'ok', message: 'Free Plan subscription created' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});


module.exports = router;
