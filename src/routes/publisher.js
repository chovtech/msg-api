const express = require('express');
const router = express.Router();
const connect = require('./queue');
const db = require('../config/db');
const authVendor = require('../middleware/authVendor');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');

// Helper function to fill message templates
function fillTemplate(template, data) {
  return template.replace(/\{\{(.*?)\}\}/g, (_, key) => data[key.trim()] || '');
}

// Helper function to determine message type based on URL
function getMessageType(url) {
  if (!url) return 'text';
  
  const extension = url.split('.').pop().split('?')[0].toLowerCase();
  const mimeType = mime.lookup(extension);
  
  if (!mimeType) return 'text';
  
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'document';
  if (mimeType.includes('word') || mimeType.includes('excel') || mimeType.includes('powerpoint')) {
    return 'document';
  }
  
  return 'text';
}

router.post('/', authVendor, async (req, res) => {
  const { contacts, message, template_id, user_id, file_url, caption } = req.body;
  const api_consumer_id = req.apiConsumerId;
  
  // Validate required fields
  if (!contacts || !user_id) {
    return res.status(400).json({ 
      error: 'Missing required fields: contacts or user_id' 
    });
  }

  // Validate at least message or file_url is provided
  if (!message && !file_url) {
    return res.status(400).json({ 
      error: 'Either message or file_url must be provided' 
    });
  }

  // Validate contacts is an array with at least one entry
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ 
      error: 'Contacts must be a non-empty array' 
    });
  }

  try {
    // 1. Validate user exists and belongs to this API consumer
    const [userCheck] = await db.query(
      `SELECT id FROM app_users WHERE id = ? AND api_consumer_id = ?`,
      [user_id, api_consumer_id]
    );
    
    if (userCheck.length === 0) {
      return res.status(404).json({ 
        error: 'User not found or not associated with this API consumer' 
      });
    }

    // 2. Check active subscription
    const [subscription] = await db.query(`
      SELECT s.*, p.max_messages, p.max_phone_numbers
      FROM subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.app_user_id = ? 
        AND s.status = 'active'
        AND s.ends_at > NOW()
      ORDER BY s.ends_at DESC
      LIMIT 1
    `, [user_id]);

    if (!subscription || subscription.length === 0) {
      return res.status(403).json({ 
        error: 'No active subscription found for this user',
        code: 'NO_ACTIVE_SUBSCRIPTION'
      });
    }

    // 3. Validate contacts are in the authorized contact_lists table
    const contactNumbers = contacts.map(c => c.number.replace(/\D/g, ''));
    
    const [authorizedContacts] = await db.query(`
      SELECT phone_number 
      FROM contact_lists 
      WHERE app_user_id = ? 
        AND api_consumer_id = ?
        AND phone_number IN (?)
    `, [user_id, api_consumer_id, contactNumbers]);

    const authorizedNumbers = new Set(authorizedContacts.map(c => c.phone_number));
    
    const invalidContacts = contacts.filter(contact => 
      !authorizedNumbers.has(contact.number.replace(/\D/g, ''))
    );

    if (invalidContacts.length > 0) {
      return res.status(400).json({
        error: 'Some numbers are not authorized for messaging',
        code: 'UNAUTHORIZED_NUMBERS',
        invalidContacts: invalidContacts.map(c => c.number),
        allowedNumbers: Array.from(authorizedNumbers)
      });
    }

    // 4. Generate batch ID for tracking
    const batch_id = uuidv4();
    
    // 5. Connect to RabbitMQ
    const channel = await connect();
    const failedMessages = [];
    const successfulMessages = [];

    // 6. Process each contact
    for (const contact of contacts) {
      try {
        const formattedNumber = contact.number.replace(/\D/g, '');
        const messageType = file_url ? getMessageType(file_url) : 'text';
        
        const payload = {
          batch_id,
          number: formattedNumber,
          user_id,
          api_consumer_id,
          type: messageType,
          media_url: file_url || null,
          media_filename: file_url ? file_url.split('/').pop().split('?')[0] : null,
          metadata: {
            ...contact.metadata,
            template_id
          }
        };

        // Add content based on message type
        if (messageType === 'text') {
          payload.message = fillTemplate(message, contact);
        } else {
          if (message) {
            payload.message = fillTemplate(message, contact);
          } else if (caption) {
            payload.message = fillTemplate(caption, contact);
          }
        }

        // Send to queue
        channel.sendToQueue(
          'whatsapp_msg_queue',
          Buffer.from(JSON.stringify(payload)),
          { persistent: true }
        );

        // Log in database
        await db.query(`
          INSERT INTO sent_messages (
            batch_id, api_consumer_id, app_user_id, 
            recipient, message, channel, status, 
            message_type, media_url
          ) VALUES (?, ?, ?, ?, ?, 'whatsapp', 'pending', ?, ?)
        `, [
          batch_id,
          api_consumer_id,
          user_id,
          formattedNumber,
          messageType === 'text' ? payload.message : payload.message || '',
          messageType,
          file_url || null
        ]);

        successfulMessages.push(formattedNumber);
      } catch (err) {
        console.error(`Failed to queue message for ${contact.number}:`, err);
        failedMessages.push({
          number: contact.number,
          error: err.message
        });
      }
    }
    
    // 7. Return appropriate response
    if (failedMessages.length === 0) {
      return res.json({
        status: 'queued',
        batch_id,
        count: successfulMessages.length
      });
    } else if (successfulMessages.length === 0) {
      return res.status(500).json({
        status: 'failed',
        error: 'All messages failed to queue',
        failures: failedMessages
      });
    } else {
      return res.status(207).json({
        status: 'partial_success',
        batch_id,
        success_count: successfulMessages.length,
        failed_count: failedMessages.length,
        failures: failedMessages
      });
    }
  } catch (err) {
    console.error('Error in send-message:', err);
    return res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

module.exports = router;