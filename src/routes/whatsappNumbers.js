const express = require('express');
const validator = require('validator');
const db = require('../config/db');
const authVendor = require('../middleware/authVendor');
const router = express.Router();

router.post('/:userId/add', authVendor, async (req, res) => {
  try {
    const { label, phone_number } = req.body;
    const { userId } = req.params;
    const api_consumer_id = req.apiConsumerId;

    if (!phone_number) {
      return res.status(400).json({ message: 'Phone number is required' });
    }

    // Step 1: Verify user belongs to vendor
    const [user] = await db.query(
      'SELECT * FROM app_users WHERE id = ? AND api_consumer_id = ?',
      [userId, api_consumer_id]
    );
    if (!user.length) {
      return res.status(404).json({ message: 'User not found or does not belong to you' });
    }

    // Get active subscription and plan
const [subscriptions] = await db.query(
  `SELECT s.*, p.max_phone_numbers
   FROM subscriptions s
   JOIN plans p ON s.plan_id = p.id
   WHERE s.app_user_id = ? AND s.status = 'active' AND s.ends_at > NOW()`,
  [userId]
);

if (!subscriptions.length) {
  return res.status(403).json({ message: 'No active subscription found for user' });
}

const maxAllowed = subscriptions[0].max_phone_numbers;

// Count current WhatsApp numbers for this user
const [currentNumbers] = await db.query(
  'SELECT COUNT(*) as count FROM whatsapp_numbers WHERE app_user_id = ?',
  [userId]
);

if (currentNumbers[0].count >= maxAllowed) {
  return res.status(403).json({
    message: `Phone number limit reached. Your current plan allows a maximum of ${maxAllowed} number(s).`
  });
}

    // Step 4: Prevent duplicate number for vendor
    const [existing] = await db.query(
      `SELECT wn.id FROM whatsapp_numbers wn
       JOIN app_users au ON wn.app_user_id = au.id
       WHERE wn.phone_number = ? AND au.api_consumer_id = ?`,
      [phone_number, api_consumer_id]
    );
    if (existing.length > 0) {
      return res.status(409).json({ message: 'This phone number already exists under your vendor account' });
    }

    // Step 5: Add number
    const [result] = await db.query(
      `INSERT INTO whatsapp_numbers (app_user_id, label, phone_number, created_at)
       VALUES (?, ?, ?, NOW())`,
      [userId, label || null, phone_number]
    );

    return res.status(201).json({
      status: 'ok',
      message: 'WhatsApp number added successfully',
      id: result.insertId
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});


// PATCH /users/:userId/whatsapp-numbers/:numberId
router.patch('/:userId/update/:numberId', authVendor, async (req, res) => {
  try {
    const { userId, numberId } = req.params;
    const { label } = req.body;
    const api_consumer_id = req.apiConsumerId;

    if (label === undefined) {
      return res.status(400).json({ message: 'Only label can be updated' });
    }

    // Ensure user belongs to vendor
    const [user] = await db.query(
      'SELECT * FROM app_users WHERE id = ? AND api_consumer_id = ?',
      [userId, api_consumer_id]
    );
    if (!user.length) {
      return res.status(404).json({ message: 'User not found or does not belong to you' });
    }

    // Ensure WhatsApp number exists and belongs to the user
    const [existing] = await db.query(
      `SELECT wn.id FROM whatsapp_numbers wn
       JOIN app_users au ON wn.app_user_id = au.id
       WHERE wn.id = ? AND au.id = ? AND au.api_consumer_id = ?`,
      [numberId, userId, api_consumer_id]
    );
    if (!existing.length) {
      return res.status(404).json({ message: 'WhatsApp number not found or does not belong to this user' });
    }

    // Update label
    await db.query(`UPDATE whatsapp_numbers SET label = ? WHERE id = ?`, [label, numberId]);

    return res.json({ status: 'ok', message: 'Label updated successfully' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /users/:userId/whatsapp-numbers
router.get('/:userId/list', authVendor, async (req, res) => {
  try {
    const { userId } = req.params;
    const api_consumer_id = req.apiConsumerId;

    // Verify the user belongs to the vendor
    const [user] = await db.query(
      'SELECT * FROM app_users WHERE id = ? AND api_consumer_id = ?',
      [userId, api_consumer_id]
    );
    if (!user.length) {
      return res.status(404).json({ message: 'User not found or does not belong to you' });
    }

    // Fetch WhatsApp numbers
    const [numbers] = await db.query(
      `SELECT id, label, phone_number, is_active, created_at
       FROM whatsapp_numbers
       WHERE app_user_id = ?`,
      [userId]
    );

    return res.json({ status: 'ok', count: numbers.length, data: numbers });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// DELETE /users/:userId/whatsapp-numbers/:numberId
router.delete('/:userId/delete/:numberId', authVendor, async (req, res) => {
  try {
    const { userId, numberId } = req.params;
    const api_consumer_id = req.apiConsumerId;

    // Ensure user belongs to vendor
    const [user] = await db.query(
      'SELECT * FROM app_users WHERE id = ? AND api_consumer_id = ?',
      [userId, api_consumer_id]
    );
    if (!user.length) {
      return res.status(404).json({ message: 'User not found or does not belong to you' });
    }

    // Ensure WhatsApp number exists and belongs to the user
    const [existing] = await db.query(
      `SELECT wn.id FROM whatsapp_numbers wn
       JOIN app_users au ON wn.app_user_id = au.id
       WHERE wn.id = ? AND au.id = ? AND au.api_consumer_id = ?`,
      [numberId, userId, api_consumer_id]
    );
    if (!existing.length) {
      return res.status(404).json({ message: 'WhatsApp number not found or does not belong to this user' });
    }

    await db.query('DELETE FROM whatsapp_numbers WHERE id = ?', [numberId]);

    return res.json({ status: 'ok', message: 'WhatsApp number deleted successfully' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;