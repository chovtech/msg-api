const db = require('../config/db');

const authVendor = async (req, res, next) => {
  try {
    // Check header first (for external API consumers), then fall back to httpOnly cookie (for frontend)
    const apiKey = req.header('x-api-key') || (req.cookies && req.cookies['wamator_api_key']);

    if (!apiKey) {
      return res.status(401).json({ message: 'API Key required' });
    }

    // Validate API key against DB
    const [vendor] = await db.query('SELECT id, name FROM api_consumer WHERE api_key = ?', [apiKey]);

    if (!vendor.length) {
      return res.status(401).json({ message: 'Invalid API Key' });
    }

    // Attach vendor info to request for use in routes
    req.vendor = vendor[0];
    req.apiConsumerId = vendor[0].id; // ✅ this line sets it clearly
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ message: 'Authentication failed' });
  }
};

module.exports = authVendor;
