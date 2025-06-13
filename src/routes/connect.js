const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authVendor = require('../middleware/authVendor');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

// Track WhatsApp client sessions
const clients = {};

router.post('/:userId/:phoneNumber', authVendor, async (req, res) => {
  const { userId, phoneNumber } = req.params;
  const apiConsumerId = req.apiConsumerId;

  // Get Socket.IO instance from app
  const io = req.app.get('io');
  const activeConnections = req.app.get('activeConnections');

  try {
    const [results] = await db.query(
      `
      SELECT wn.id AS whatsapp_number_id,
             wn.is_active,
             au.id AS app_user_id,
             sub.id AS subscription_id,
             sub.status,
             p.max_phone_numbers,
             (
               SELECT COUNT(*) 
               FROM whatsapp_numbers 
               WHERE app_user_id = au.id AND is_active = 1
             ) AS active_numbers
      FROM app_users au
      JOIN whatsapp_numbers wn ON wn.app_user_id = au.id
      LEFT JOIN subscriptions sub ON sub.app_user_id = au.id AND sub.status = 'active'
      LEFT JOIN plans p ON p.id = sub.plan_id
      WHERE au.id = ?
        AND au.api_consumer_id = ?
        AND wn.phone_number = ?
      LIMIT 1
      `,
      [userId, apiConsumerId, phoneNumber]
    );

    if (results.length === 0) {
      return res.status(403).json({
        status: 'error',
        message: 'User and phone number not associated with this API consumer.',
      });
    }

    const record = results[0];

    if (!record.subscription_id || record.status !== 'active') {
      return res.status(403).json({
        status: 'error',
        message: 'No active subscription for this user.',
      });
    }

    if (record.is_active === 1) {
      return res.status(409).json({
        status: 'error',
        message: 'WhatsApp number is already connected.',
      });
    }

    if (record.active_numbers >= record.max_phone_numbers) {
      return res.status(403).json({
        status: 'error',
        message: 'Phone number limit exceeded for current plan.',
      });
    }


    const sessionId = `${apiConsumerId}-${userId}-${phoneNumber}`;

    // Prevent double connections
    if (clients[sessionId]) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Session already being initialized, Wait to get QR code.', 
      });
    }

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
      puppeteer: { headless: true, args: ['--no-sandbox'] }
    });

    

    clients[sessionId] = client;
    // First, respond that QR generation is starting
    res.status(200).json({
      status: 'processing',
      message: 'Generating QR code...',
      session_id: sessionId
    });

    client.on('qr', async (qr) => {
      qrcodeTerminal.generate(qr, { small: true });
      const qrImage = await qrcode.toDataURL(qr);

      // Emit to the specific user if their socket is connected
      const userSocketId = activeConnections[userId];
      if (userSocketId) {
        io.to(userSocketId).emit('qr_generated', {
          status: 'success',
          message: 'Scan the QR to connect',
          session_id: sessionId,
          qr_code: qrImage,
          data: {
            app_user_id: record.app_user_id,
            whatsapp_number_id: record.whatsapp_number_id,
            active_numbers: record.active_numbers,
            allowed_max: record.max_phone_numbers
          }
        });
      } else {
        console.warn(`User ${userId} has no active socket connection`);
      }
    });

    client.on('ready', async () => {
      console.log(`[✅ CONNECTED] ${sessionId}`);
      
      // Update DB
      await db.query(`
        UPDATE whatsapp_numbers
        SET session_id = ?, is_active = 1
        WHERE app_user_id = ? AND phone_number = ?
      `, [sessionId, userId, phoneNumber]);

      // Notify client of successful connection
      const userSocketId = activeConnections[userId];
      if (userSocketId) {
        io.to(userSocketId).emit('connection_update', {
          status: 'connected',
          message: 'WhatsApp client is now ready!'
        });
      }
    });

    client.on('disconnected', (reason) => {
      console.log(`[❌ DISCONNECTED] ${sessionId}:`, reason);
      delete clients[sessionId];
      
      const userSocketId = activeConnections[userId];
      if (userSocketId) {
        io.to(userSocketId).emit('connection_update', {
          status: 'disconnected',
          message: 'WhatsApp client was disconnected'
        });
      }
    });

    client.initialize();

    

   } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
});

module.exports = router;
