import { db } from './db.js';

export const initializeDatabase = async () => {
  console.log('Initializing database...');
  
  try {
    // 1. Create settings table
    await db.query(`
      CREATE TABLE IF NOT EXISTS settings (
        \`key\` VARCHAR(100) PRIMARY KEY,
        \`value\` TEXT NOT NULL,
        \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Settings table ready');
    
    // 2. Ensure orders table has subtotal and tax_amount columns
    // Check if columns exist and add them if not
    const columns = await db.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'orders'
    `);
    
    const columnNames = Array.isArray(columns) ? columns.map(c => c.COLUMN_NAME) : [];
    
    if (!columnNames.includes('subtotal')) {
      await db.query(`
        ALTER TABLE orders 
        ADD COLUMN subtotal DECIMAL(10,2) AFTER user_id
      `);
      console.log('✓ Added subtotal column to orders');
    }
    
    if (!columnNames.includes('tax_amount')) {
      await db.query(`
        ALTER TABLE orders 
        ADD COLUMN tax_amount DECIMAL(10,2) AFTER subtotal
      `);
      console.log('✓ Added tax_amount column to orders');
    }
    
    // 3. Initialize default tax rate
    const result = await db.query('SELECT * FROM settings WHERE `key` = ?', ['tax_rate']);
    if (result.length === 0) {
      await db.query(
        'INSERT INTO settings (`key`, value) VALUES (?, ?)',
        ['tax_rate', '0.08']
      );
      console.log('✓ Default tax rate (8%) initialized');
    }
    
    console.log('Database initialization complete!');
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
};
