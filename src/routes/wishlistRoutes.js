import express from 'express';
import { db } from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { normalizeResult } from '../utils/helpers.js';
import { getPresignedUrl } from '../config/s3.js';

const router = express.Router();

// Get user's wishlist
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const result = await db.query(
    `SELECT w.id, w.product_id, w.created_at,
            p.uuid, p.name, p.price, p.category, p.image_url, p.status, p.stock_quantity
     FROM wishlists w
     JOIN products p ON w.product_id = p.id
     WHERE w.user_id = ?
     ORDER BY w.created_at DESC`,
    [userId]
  );
  let items = normalizeResult(result);

  items = await Promise.all(
    items.map(async (item) => {
      // Get primary image from product_images
      const imgResult = await db.query(
        'SELECT image_url FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, sort_order ASC LIMIT 1',
        [item.product_id]
      );
      const imgs = normalizeResult(imgResult);
      const imageUrl = imgs.length > 0 ? imgs[0].image_url : item.image_url;
      return {
        ...item,
        image_url: imageUrl ? await getPresignedUrl(imageUrl, 3600).catch(() => imageUrl) : null,
      };
    })
  );

  res.json({ items });
}));

// Add to wishlist
router.post('/', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { product_id } = req.body;
  if (!product_id) return res.status(400).json({ message: 'product_id is required' });

  // Verify product exists
  const prod = normalizeResult(await db.query('SELECT id FROM products WHERE id = ?', [product_id]));
  if (!prod.length) return res.status(404).json({ message: 'Product not found' });

  await db.query(
    'INSERT IGNORE INTO wishlists (user_id, product_id) VALUES (?, ?)',
    [userId, product_id]
  );
  res.status(201).json({ message: 'Added to wishlist' });
}));

// Remove from wishlist
router.delete('/:productId', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { productId } = req.params;
  await db.query('DELETE FROM wishlists WHERE user_id = ? AND product_id = ?', [userId, productId]);
  res.json({ message: 'Removed from wishlist' });
}));

// Check if product is in wishlist
router.get('/check/:productId', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { productId } = req.params;
  const result = normalizeResult(
    await db.query('SELECT id FROM wishlists WHERE user_id = ? AND product_id = ?', [userId, productId])
  );
  res.json({ inWishlist: result.length > 0 });
}));

export default router;
