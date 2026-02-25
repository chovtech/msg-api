const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authVendor = require('../middleware/authVendor');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

// ─────────────────────────────────────────────
// In-memory store of active WhatsApp clients
// ─────────────────────────────────────────────
const clients = {};

router.post('/:userId/:phoneNumber', authVendor, async (req, res) => {
  const { userId, phoneNumber } = req.params;
  const apiConsumerId = req.apiConsumerId;

  const io = req.app.get('io');
  const activeConnections = req.app.get('activeConnections');

  // ─────────────────────────────────────────────
  // 1. Database checks
  // ─────────────────────────────────────────────
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

    // ─────────────────────────────────────────────
    // 2. Prevent duplicate sessions
    // ─────────────────────────────────────────────
    const sessionId = `${apiConsumerId}-${userId}-${phoneNumber}`;

    if (clients[sessionId]) {
      return res.status(400).json({
        status: 'error',
        message: 'Session already being initialized. Please wait for the QR code.',
      });
    }

    // ─────────────────────────────────────────────
    // 3. Create WhatsApp client with correct Puppeteer config
    //    --disable-dev-shm-usage is the most critical flag for Docker VPS
    // ─────────────────────────────────────────────
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: '/app/.wwebjs_auth',
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
        ],
      },
    });

    // Store immediately to block duplicate requests
    clients[sessionId] = client;

    // ─────────────────────────────────────────────
    // 4. Respond immediately — QR will come via Socket.IO
    // ─────────────────────────────────────────────
    res.status(200).json({
      status: 'processing',
      message: 'Generating QR code...',
      session_id: sessionId,
    });

    // ─────────────────────────────────────────────
    // 5. Failsafe: destroy client if READY never fires within 90 seconds
    // ─────────────────────────────────────────────
    const readyTimeout = setTimeout(async () => {
      if (clients[sessionId]) {
        console.error(`[TIMEOUT] ${sessionId} — never reached READY after 90s. Destroying.`);

        // Log what URL the browser was stuck on (helpful for debugging)
        try {
          if (client.pupPage) {
            const url = client.pupPage.url();
            console.error(`[TIMEOUT] Browser was stuck on: ${url}`);
          }
        } catch (_) {}

        try {
          await client.destroy();
        } catch (e) {
          console.error(`[TIMEOUT] Error during destroy:`, e.message);
        }

        delete clients[sessionId];

        const userSocketId = activeConnections[userId];
        if (userSocketId) {
          io.to(userSocketId).emit('connection_update', {
            status: 'timeout',
            message: 'Connection timed out. Please try again.',
          });
        }
      }
    }, 90_000);

    // ─────────────────────────────────────────────
    // 6. WhatsApp Events
    // ─────────────────────────────────────────────

    // QR code generated — send to frontend via Socket.IO
    client.on('qr', async (qr) => {
      qrcodeTerminal.generate(qr, { small: true });
      console.log(`[QR] Generated for ${sessionId}`);

      try {
        const qrImage = await qrcode.toDataURL(qr, { width: 512, margin: 2 });
        const userSocketId = activeConnections[userId];

        if (userSocketId) {
          io.to(userSocketId).emit('qr_generated', {
            status: 'success',
            message: 'Scan the QR code to connect WhatsApp',
            session_id: sessionId,
            qr_code: qrImage,
            data: {
              app_user_id: record.app_user_id,
              whatsapp_number_id: record.whatsapp_number_id,
              active_numbers: record.active_numbers,
              allowed_max: record.max_phone_numbers,
            },
          });
        } else {
          console.warn(`[QR] User ${userId} has no active socket — QR printed to terminal only`);
        }
      } catch (err) {
        console.error(`[QR] Failed to generate QR image for ${sessionId}:`, err.message);
      }
    });

    // Authenticated — session restored or QR scanned successfully
    client.on('authenticated', () => {
      console.log(`[AUTHENTICATED] ${sessionId}`);

      const userSocketId = activeConnections[userId];
      if (userSocketId) {
        io.to(userSocketId).emit('connection_update', {
          status: 'authenticated',
          message: 'QR code scanned! Loading WhatsApp...',
        });
      }

      try {
        if (client.pupPage) {
          client.pupPage.on('error', (err) =>
            console.error(`[BROWSER CRASH] ${sessionId}:`, err.message)
          );
          client.pupPage.on('pageerror', (err) =>
            console.error(`[PAGE ERROR] ${sessionId}:`, err.message)
          );
          client.pupPage.on('console', (msg) => {
            if (msg.type() === 'error') {
              console.error(`[BROWSER CONSOLE ERROR] ${sessionId}:`, msg.text());
            }
          });
        }
      } catch (_) {}
    });

    // Loading screen — shows progress between authenticated and ready
    client.on('loading_screen', (percent, message) => {
      console.log(`[LOADING] ${sessionId} — ${percent}% — ${message}`);

      const userSocketId = activeConnections[userId];
      if (userSocketId) {
        io.to(userSocketId).emit('connection_update', {
          status: 'loading',
          message: `Loading WhatsApp... ${percent}%`,
          percent,
        });
      }
    });

    // State changes — useful for seeing exactly where it stalls
    client.on('change_state', (state) => {
      console.log(`[STATE] ${sessionId} →`, state);
    });

    // Auth failure — bad session data, need to re-scan
    client.on('auth_failure', async (msg) => {
      console.error(`[AUTH FAILURE] ${sessionId}:`, msg);
      clearTimeout(readyTimeout);
      delete clients[sessionId];

      const userSocketId = activeConnections[userId];
      if (userSocketId) {
        io.to(userSocketId).emit('connection_update', {
          status: 'auth_failure',
          message: 'Authentication failed. Please try connecting again.',
        });
      }
    });

    // Ready — WhatsApp fully loaded, safe to update DB
    client.on('ready', async () => {
      clearTimeout(readyTimeout);
      console.log(`[✅ READY] ${sessionId}`);

      try {
        await db.query(
          `UPDATE whatsapp_numbers
           SET session_id = ?, is_active = 1
           WHERE app_user_id = ? AND phone_number = ?`,
          [sessionId, userId, phoneNumber]
        );
        console.log(`[DB] Updated is_active=1 for ${sessionId}`);
      } catch (err) {
        console.error(`[DB] Failed to update after ready:`, err.message);
      }

      const userSocketId = activeConnections[userId];
      if (userSocketId) {
        io.to(userSocketId).emit('connection_update', {
          status: 'connected',
          message: 'WhatsApp is now connected!',
        });
      }
    });

    // Disconnected — clean up
    client.on('disconnected', async (reason) => {
      clearTimeout(readyTimeout);
      console.log(`[❌ DISCONNECTED] ${sessionId}:`, reason);
      delete clients[sessionId];

      try {
        await db.query(
          `UPDATE whatsapp_numbers SET is_active = 0, session_id = NULL
           WHERE app_user_id = ? AND phone_number = ?`,
          [userId, phoneNumber]
        );
      } catch (err) {
        console.error(`[DB] Failed to update after disconnect:`, err.message);
      }

      const userSocketId = activeConnections[userId];
      if (userSocketId) {
        io.to(userSocketId).emit('connection_update', {
          status: 'disconnected',
          message: 'WhatsApp was disconnected.',
        });
      }
    });

    // ─────────────────────────────────────────────
    // 7. Start the client
    // ─────────────────────────────────────────────
    client.initialize();

  } catch (err) {
    console.error('[ROUTE ERROR]', err);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error.',
    });
  }
});

module.exports = router;
module.exports.clients = clients;