const express = require('express');
const validator = require('validator');
const db = require('../config/db');
const authVendor = require('../middleware/authVendor');
const formatPhoneNumber = require('../utils/formatPhoneNumber');
const router = express.Router();


router.post('/:id/add', authVendor, async (req, res) => {
  try {
    const api_consumer_id = req.apiConsumerId;
    const app_user_id = req.params.id;

    const contacts = Array.isArray(req.body) ? req.body : [req.body];

    const formattedContacts = [];

    // Step 1: Format phone numbers and filter valid ones
    for (const contact of contacts) {
      if (!contact.phone_number) continue;

      const formattedPhone = formatPhoneNumber(contact.phone_number);
      if (!formattedPhone) continue;

      contact._formattedPhone = formattedPhone;
      formattedContacts.push(contact);
    }

    if (formattedContacts.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'No valid contact with phone number provided'
      });
    }

    // Step 2: Get all existing phone numbers for this vendor and user
    const formattedPhoneList = formattedContacts.map(c => `'${c._formattedPhone}'`).join(',');
    const [existingRows] = await db.query(
      `SELECT phone_number FROM contact_lists WHERE api_consumer_id = ? AND app_user_id = ? AND phone_number IN (${formattedPhoneList})`,
      [api_consumer_id, app_user_id]
    );

    const existingPhoneNumbers = new Set(existingRows.map(row => row.phone_number));

    const values = [];

    // Step 3: Prepare filtered insert values
    for (const contact of formattedContacts) {
      const formattedPhone = contact._formattedPhone;
      if (existingPhoneNumbers.has(formattedPhone)) continue;

      const {
        name,
        phone_number,
        email,
        company_name,
        gender,
        dob,
        age_group,
        language_preference,
        preferred_contact_time,
        nickname,
        custom_salutation,
        partner_name,
        anniversary_date,
        kids_names,
        number_of_kids,
        pets_names,
        job_title,
        industry,
        work_anniversary,
        state,
        city,
        country,
        address,
        timezone,
        interests,
        preferred_products,
        last_contacted_at,
        message_opt_in = true,
        whatsapp_broadcast_preference,
        last_purchase_date,
        average_spend,
        customer_tier
      } = contact;

      const safeEmail = email && validator.isEmail(email) ? validator.normalizeEmail(email) : null;
      const safeName = name ? validator.trim(name) : null;
      const safeCompanyName = company_name ? validator.trim(company_name) : null;

      values.push([
        api_consumer_id,
        app_user_id,
        safeName,
        formattedPhone,
        safeEmail,
        safeCompanyName,
        gender,
        dob,
        age_group,
        language_preference,
        preferred_contact_time,
        nickname,
        custom_salutation,
        partner_name,
        anniversary_date,
        kids_names ? JSON.stringify(kids_names) : null,
        number_of_kids,
        pets_names ? JSON.stringify(pets_names) : null,
        job_title,
        industry,
        work_anniversary,
        state,
        city,
        country,
        address,
        timezone,
        interests ? JSON.stringify(interests) : null,
        preferred_products ? JSON.stringify(preferred_products) : null,
        last_contacted_at,
        message_opt_in,
        whatsapp_broadcast_preference ? JSON.stringify(whatsapp_broadcast_preference) : null,
        last_purchase_date,
        average_spend,
        customer_tier
      ]);
    }

    if (!values.length) {
      return res.status(409).json({
        status: 'warning',
        message: 'All submitted contacts already exist'
      });
    }

    const insertQuery = `
      INSERT INTO contact_lists (
        api_consumer_id, app_user_id, name, phone_number, email, company_name,
        gender, dob, age_group, language_preference, preferred_contact_time, nickname,
        custom_salutation, partner_name, anniversary_date, kids_names, number_of_kids,
        pets_names, job_title, industry, work_anniversary, state, city, country, address,
        timezone, interests, preferred_products, last_contacted_at, message_opt_in,
        whatsapp_broadcast_preference, last_purchase_date, average_spend, customer_tier
      ) VALUES ?
    `;

    await db.query(insertQuery, [values]);

    return res.status(201).json({
      status: 'success',
      message: `${values.length} contact(s) added successfully`
    });

  } catch (error) {
    console.error('Error adding contact(s):', error);
    return res.status(500).json({
      status: 'error',
      message: 'Something went wrong'
    });
  }
});


// PATCH /:id/batch-update - Update multiple contacts for the user
router.patch('/:id/batch-update', authVendor, async (req, res) => {
  try {
    const api_consumer_id = req.apiConsumerId;
    const app_user_id = req.params.id;
    const contacts = req.body.contacts;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'No contacts provided for batch update'
      });
    }

    const sanitize = (val) => (typeof val === 'string' ? validator.trim(val) : val);

    const updateMap = {
      name: 'name',
      email: 'email',
      company_name: 'company_name',
      gender: 'gender',
      dob: 'dob',
      age_group: 'age_group',
      language_preference: 'language_preference',
      preferred_contact_time: 'preferred_contact_time',
      nickname: 'nickname',
      custom_salutation: 'custom_salutation',
      partner_name: 'partner_name',
      anniversary_date: 'anniversary_date',
      kids_names: 'kids_names',
      number_of_kids: 'number_of_kids',
      pets_names: 'pets_names',
      job_title: 'job_title',
      industry: 'industry',
      work_anniversary: 'work_anniversary',
      state: 'state',
      city: 'city',
      country: 'country',
      address: 'address',
      timezone: 'timezone',
      interests: 'interests',
      preferred_products: 'preferred_products',
      last_contacted_at: 'last_contacted_at',
      message_opt_in: 'message_opt_in',
      whatsapp_broadcast_preference: 'whatsapp_broadcast_preference',
      last_purchase_date: 'last_purchase_date',
      average_spend: 'average_spend',
      customer_tier: 'customer_tier'
    };

    const results = [];

    for (const contact of contacts) {
      const contact_id = contact.id;
      if (!contact_id) continue;

      const fields = contact;
      const updates = [];
      const values = [];

      for (const [key, column] of Object.entries(updateMap)) {
        if (fields.hasOwnProperty(key)) {
          let val = fields[key];

          if (['interests', 'preferred_products', 'kids_names', 'pets_names', 'whatsapp_broadcast_preference'].includes(key)) {
            val = JSON.stringify(val);
          } else if (key === 'email') {
            val = validator.isEmail(val) ? validator.normalizeEmail(val) : null;
          } else {
            val = sanitize(val);
          }

          updates.push(`${column} = ?`);
          values.push(val);
        }
      }

      if (updates.length === 0) {
        results.push({ contact_id, status: 'skipped', reason: 'No valid fields to update' });
        continue;
      }

      const updateQuery = `
        UPDATE contact_lists
        SET ${updates.join(', ')}
        WHERE id = ? AND api_consumer_id = ? AND app_user_id = ?
      `;

      values.push(contact_id, api_consumer_id, app_user_id);

      const [result] = await db.query(updateQuery, values);

      if (result.affectedRows === 0) {
        results.push({ contact_id, status: 'failed', reason: 'Contact not found or unauthorized' });
      } else {
        results.push({ contact_id, status: 'success' });
      }
    }

    return res.status(200).json({
      status: 'completed',
      results
    });

  } catch (error) {
    console.error('Batch update error:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Something went wrong during batch update'
    });
  }
});

//patch /:id/:contactId - Update a specific contact for the user
router.patch('/:id/:contactId', authVendor, async (req, res) => {
  try {
    const api_consumer_id = req.apiConsumerId;
    const app_user_id = req.params.id;
    const contact_id = req.params.contactId;

    const fields = req.body;
    if (!fields || Object.keys(fields).length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'No fields provided for update'
      });
    }

    const updates = [];
    const values = [];

    const sanitize = (val) => (typeof val === 'string' ? validator.trim(val) : val);

    const updateMap = {
      name: 'name',
      email: 'email',
      company_name: 'company_name',
      gender: 'gender',
      dob: 'dob',
      age_group: 'age_group',
      language_preference: 'language_preference',
      preferred_contact_time: 'preferred_contact_time',
      nickname: 'nickname',
      custom_salutation: 'custom_salutation',
      partner_name: 'partner_name',
      anniversary_date: 'anniversary_date',
      kids_names: 'kids_names',
      number_of_kids: 'number_of_kids',
      pets_names: 'pets_names',
      job_title: 'job_title',
      industry: 'industry',
      work_anniversary: 'work_anniversary',
      state: 'state',
      city: 'city',
      country: 'country',
      address: 'address',
      timezone: 'timezone',
      interests: 'interests',
      preferred_products: 'preferred_products',
      last_contacted_at: 'last_contacted_at',
      message_opt_in: 'message_opt_in',
      whatsapp_broadcast_preference: 'whatsapp_broadcast_preference',
      last_purchase_date: 'last_purchase_date',
      average_spend: 'average_spend',
      customer_tier: 'customer_tier'
    };

    for (const [key, column] of Object.entries(updateMap)) {
      if (fields.hasOwnProperty(key)) {
        let val = fields[key];

        if (['interests', 'preferred_products', 'kids_names', 'pets_names', 'whatsapp_broadcast_preference'].includes(key)) {
          val = JSON.stringify(val);
        } else if (key === 'email') {
          val = validator.isEmail(val) ? validator.normalizeEmail(val) : null;
        } else {
          val = sanitize(val);
        }

        updates.push(`${column} = ?`);
        values.push(val);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'No valid fields to update'
      });
    }

    const updateQuery = `
      UPDATE contact_lists
      SET ${updates.join(', ')}
      WHERE id = ? AND api_consumer_id = ? AND app_user_id = ?
    `;

    values.push(contact_id, api_consumer_id, app_user_id);

    const [result] = await db.query(updateQuery, values);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Contact not found'
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Contact updated successfully'
    });

  } catch (error) {
    console.error('Error updating contact:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Something went wrong'
    });
  }
});

// DELETE /:id/batch-remove - Batch remove contacts for the user
router.delete('/:app_user_id/batch-remove', authVendor, async (req, res) => {
  try {
    const api_consumer_id = req.apiConsumerId;
    const app_user_id = req.params.app_user_id;

    // Ensure we have an array of contact IDs to delete
    const contactIds = Array.isArray(req.body) ? req.body : [req.body];
    
    if (!contactIds.length || contactIds.some(id => !id)) {
      return res.status(400).json({
        status: 'error',
        message: 'Please provide an array of valid contact IDs to delete'
      });
    }

    // Prepare the query - using parameterized query to prevent SQL injection
    const query = `
      DELETE FROM contact_lists 
      WHERE id IN (?) 
        AND api_consumer_id = ? 
        AND app_user_id = ?
    `;

    const [result] = await db.query(query, [
      contactIds,
      api_consumer_id,
      app_user_id
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'No contacts found matching the provided IDs for this user'
      });
    }

    return res.status(200).json({
      status: 'success',
      message: `Successfully deleted ${result.affectedRows} contact(s)`,
      deleted_count: result.affectedRows
    });

  } catch (error) {
    console.error('Batch delete error:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Something went wrong during batch deletion'
    });
  }
});


// GET /:app_user_id/list - List contacts for the user with pagination and search
router.get('/:app_user_id/list', authVendor, async (req, res) => {
  try {
    const api_consumer_id = req.apiConsumerId;
    const app_user_id = req.params.app_user_id;
    const { page = 1, limit = 50, search } = req.query;

    // Calculate pagination offset
    const offset = (page - 1) * limit;

    // Base query
    let query = `
      SELECT * FROM contact_lists 
      WHERE api_consumer_id = ? AND app_user_id = ?
    `;
    const queryParams = [api_consumer_id, app_user_id];

    // Add search filter if provided
    if (search && search.trim() !== '') {
      query += ` AND (
        name LIKE ? OR 
        email LIKE ? OR 
        phone_number LIKE ? OR 
        company_name LIKE ?
      )`;
      const searchTerm = `%${search.trim()}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Add pagination
    query += ` LIMIT ? OFFSET ?`;
    queryParams.push(parseInt(limit), offset);

    // Get contacts
    const [contacts] = await db.query(query, queryParams);

    // Get total count for pagination info
    let countQuery = `
      SELECT COUNT(*) as total FROM contact_lists 
      WHERE api_consumer_id = ? AND app_user_id = ?
    `;
    const countParams = [api_consumer_id, app_user_id];

    if (search && search.trim() !== '') {
      countQuery += ` AND (
        name LIKE ? OR 
        email LIKE ? OR 
        phone_number LIKE ? OR 
        company_name LIKE ?
      )`;
      const searchTerm = `%${search.trim()}%`;
      countParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    const [totalResult] = await db.query(countQuery, countParams);
    const total = totalResult[0].total;
    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      status: 'success',
      data: contacts,
      pagination: {
        total,
        totalPages,
        currentPage: parseInt(page),
        limit: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('List contacts error:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching contacts'
    });
  }
});

module.exports = router;
