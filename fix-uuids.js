import { db } from './src/config/db.js';
import { randomUUID } from 'crypto';

async function fix() {
  const products = await db.query('SELECT id, uuid FROM products');
  console.log('Products found:', products.length);

  for (const p of products) {
    if (!p.uuid) {
      const uuid = randomUUID();
      await db.query('UPDATE products SET uuid = ? WHERE id = ?', [uuid, p.id]);
      console.log('Updated product', p.id, 'with UUID:', uuid);
    } else {
      console.log('Product', p.id, 'already has UUID:', p.uuid);
    }
  }

  process.exit(0);
}

fix();
