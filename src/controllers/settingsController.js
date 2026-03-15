import { db } from '../config/db.js';
import { asyncHandler } from '../middleware/error.js';
import { normalizeResult } from '../utils/helpers.js';

// Default tax rate
const DEFAULT_TAX_RATE = 0.08; // 8%

// Ensure settings table exists
const ensureSettingsTable = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS settings (
        \`key\` VARCHAR(100) PRIMARY KEY,
        \`value\` TEXT NOT NULL,
        \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  } catch (error) {
    console.error('Failed to create settings table:', error);
  }
};

// Get all settings
export const getSettings = asyncHandler(async (req, res) => {
  const result = await db.query('SELECT * FROM settings');
  const settings = normalizeResult(result);
  
  // Convert to key-value object
  const settingsObj = settings.reduce((acc, setting) => {
    acc[setting.key] = setting.value;
    return acc;
  }, {});
  
  // Ensure tax_rate exists with default
  if (!settingsObj.tax_rate) {
    settingsObj.tax_rate = DEFAULT_TAX_RATE.toString();
  }
  
  res.json({ settings: settingsObj });
});

// Get specific setting
export const getSetting = asyncHandler(async (req, res) => {
  const { key } = req.params;
  
  const result = await db.query('SELECT * FROM settings WHERE `key` = ?', [key]);
  const settings = normalizeResult(result);
  
  if (settings.length === 0) {
    // Return default for tax_rate
    if (key === 'tax_rate') {
      return res.json({ key, value: DEFAULT_TAX_RATE.toString() });
    }
    return res.status(404).json({ message: 'Setting not found' });
  }
  
  res.json({ setting: settings[0] });
});

// Get tax rate (public endpoint for checkout)
export const getTaxRate = asyncHandler(async (req, res) => {
  const result = await db.query('SELECT value FROM settings WHERE `key` = ?', ['tax_rate']);
  const settings = normalizeResult(result);
  
  let taxRate = DEFAULT_TAX_RATE;
  if (settings.length > 0) {
    taxRate = parseFloat(settings[0].value);
    if (isNaN(taxRate) || taxRate < 0) {
      taxRate = DEFAULT_TAX_RATE;
    }
  }
  
  res.json({ 
    taxRate,
    taxRatePercent: (taxRate * 100).toFixed(0)
  });
});

// Update settings (admin only)
export const updateSettings = asyncHandler(async (req, res) => {
  const { tax_rate } = req.body;
  const updates = [];
  
  if (tax_rate !== undefined) {
    const rate = parseFloat(tax_rate);
    if (isNaN(rate) || rate < 0 || rate > 1) {
      return res.status(400).json({ message: 'Tax rate must be between 0 and 1 (0% to 100%)' });
    }
    updates.push({ key: 'tax_rate', value: rate.toString() });
  }
  
  if (updates.length === 0) {
    return res.status(400).json({ message: 'No settings to update' });
  }
  
  // Upsert settings
  for (const { key, value } of updates) {
    await db.query(
      `INSERT INTO settings (\`key\`, value, updated_at) 
       VALUES (?, ?, NOW()) 
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()`,
      [key, value]
    );
  }
  
  res.json({ 
    message: 'Settings updated successfully',
    settings: { tax_rate: updates.find(u => u.key === 'tax_rate')?.value }
  });
});

// Initialize default settings if not exists
export const initializeSettings = async () => {
  try {
    // Ensure table exists first
    await ensureSettingsTable();
    
    // Check if tax_rate exists
    const result = await db.query('SELECT * FROM settings WHERE `key` = ?', ['tax_rate']);
    if (result.length === 0) {
      await db.query(
        'INSERT INTO settings (`key`, value, updated_at) VALUES (?, ?, NOW())',
        ['tax_rate', DEFAULT_TAX_RATE.toString()]
      );
      console.log('Default tax rate initialized:', DEFAULT_TAX_RATE);
    }
  } catch (error) {
    console.error('Failed to initialize settings:', error);
  }
};
