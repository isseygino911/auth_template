import { db } from './src/config/db.js';
import { randomUUID } from 'crypto';

async function migrate() {
  try {
    // Check if uuid column exists
    const columnsResult = await db.query('SHOW COLUMNS FROM products LIKE "uuid"');
    const columns = Array.isArray(columnsResult) ? columnsResult : [];
    
    if (columns.length === 0) {
      console.log('Adding uuid column to products table...');
      
      // Add uuid column
      await db.query('ALTER TABLE products ADD COLUMN uuid VARCHAR(36) UNIQUE');
      
      // Generate UUIDs for existing products
      const products = await db.query('SELECT id FROM products');
      console.log(`Generating UUIDs for ${products.length} products...`);
      
      for (const p of products) {
        const uuid = randomUUID();
        await db.query('UPDATE products SET uuid = ? WHERE id = ?', [uuid, p.id]);
      }
      
      // Make uuid NOT NULL
      await db.query('ALTER TABLE products MODIFY uuid VARCHAR(36) NOT NULL');
      
      // Add index
      await db.query('CREATE UNIQUE INDEX idx_products_uuid ON products(uuid)');
      
      console.log('Migration completed successfully!');
    } else {
      console.log('UUID column already exists');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
