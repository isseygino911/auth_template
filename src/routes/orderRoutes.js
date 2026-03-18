import express from 'express';
import { db } from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { getPresignedUrl } from '../config/s3.js';
import { normalizeResult, generateOrderNumber } from '../utils/helpers.js';

const router = express.Router();

// Create a new order (requires authentication)
router.post('/', authMiddleware, asyncHandler(async (req, res) => {
  const { items, shipping_address, total_amount, subtotal, tax_amount } = req.body;
  const userId = req.user.userId;
  
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Order items are required' });
  }
  
  if (!shipping_address) {
    return res.status(400).json({ message: 'Shipping address is required' });
  }
  
  // Get tax rate from settings
  const taxResult = await db.query('SELECT value FROM settings WHERE `key` = ?', ['tax_rate']);
  const taxSettings = normalizeResult(taxResult);
  const taxRate = taxSettings.length > 0 ? parseFloat(taxSettings[0].value) : 0.08;
  
  // Validate subtotal matches calculated total from items
  const calculatedSubtotal = items.reduce(
    (sum, item) => sum + (item.price * item.quantity), 0
  );
  
  // Validate submitted subtotal
  if (Math.abs(calculatedSubtotal - (subtotal || 0)) > 0.01) {
    return res.status(400).json({ 
      message: 'Subtotal mismatch. Please refresh and try again.' 
    });
  }
  
  // Calculate expected tax and total
  const calculatedTax = calculatedSubtotal * taxRate;
  const calculatedTotal = calculatedSubtotal + calculatedTax;
  
  // Validate submitted total
  if (Math.abs(calculatedTotal - (total_amount || 0)) > 0.01) {
    return res.status(400).json({ 
      message: 'Total amount mismatch. Please refresh and try again.' 
    });
  }
  
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // 1. Validate stock availability and lock rows (prevents race conditions)
    for (const item of items) {
      const productResult = await connection.query(
        `SELECT stock_quantity, name FROM products WHERE id = ? FOR UPDATE`,
        [item.product_id]
      );
      const products = normalizeResult(productResult);
      
      if (products.length === 0) {
        await connection.rollback();
        return res.status(400).json({ message: `Product ID ${item.product_id} not found` });
      }
      
      const availableStock = products[0].stock_quantity;
      
      if (availableStock < item.quantity) {
        await connection.rollback();
        return res.status(400).json({
          message: `Insufficient stock for "${products[0].name}". Available: ${availableStock}, Requested: ${item.quantity}`
        });
      }
    }

    // 2. Generate order number and create order
    const orderNumber = generateOrderNumber();

    const orderResult = await connection.query(
      `INSERT INTO orders (order_number, user_id, subtotal, tax_amount, total_amount, status, shipping_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orderNumber, userId, calculatedSubtotal, calculatedTax, calculatedTotal, 'pending', JSON.stringify(shipping_address)]
    );

    const orderId = orderResult.insertId;

    // 3. Create order items and deduct stock
    for (const item of items) {
      const productResult = await connection.query(
        `SELECT name FROM products WHERE id = ?`,
        [item.product_id]
      );
      const products = normalizeResult(productResult);

      await connection.query(
        `INSERT INTO order_items (order_id, product_id, quantity, price_at_time, product_name_snapshot)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, item.product_id, item.quantity, item.price, products[0]?.name || '']
      );

      // Deduct stock immediately
      await connection.query(
        `UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?`,
        [item.quantity, item.product_id]
      );
    }
    
    await connection.commit();
    
    // Fetch the created order
    const orderQuery = await db.query(
      'SELECT * FROM orders WHERE id = ?',
      [orderId]
    );
    const order = normalizeResult(orderQuery)[0];
    
    res.status(201).json({
      message: 'Order created successfully',
      order: {
        ...order,
        shipping_address: JSON.parse(order.shipping_address || '{}'),
      }
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating order:', error);
    throw error;
  } finally {
    connection.release();
  }
}));

// Get current user's orders (requires authentication)
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  
  const result = await db.query(
    `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
  let orders = normalizeResult(result);
  
  // For each order, get the first item's image
  orders = await Promise.all(
    orders.map(async (order) => {
      const itemResult = await db.query(
        `SELECT COALESCE(NULLIF(oi.product_name_snapshot, ''), p.name) AS name, p.image_url
         FROM order_items oi
         LEFT JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = ?
         LIMIT 1`,
        [order.id]
      );
      const items = normalizeResult(itemResult);
      const firstItem = items[0];
      
      return {
        ...order,
        shipping_address: JSON.parse(order.shipping_address || '{}'),
        image_url: firstItem?.image_url ? await getPresignedUrl(firstItem.image_url, 3600) : null,
        product_name: firstItem?.name || null,
      };
    })
  );
  
  res.json({ orders });
}));

// Get single order (requires authentication)
router.get('/:id', authMiddleware, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  
  const orderResult = await db.query(
    `SELECT * FROM orders WHERE id = ? AND user_id = ?`,
    [id, userId]
  );
  const orders = normalizeResult(orderResult);
  
  if (orders.length === 0) {
    return res.status(404).json({ message: 'Order not found' });
  }
  
  const order = orders[0];
  
  // Get order items with product details
  const itemsResult = await db.query(
    `SELECT oi.*, COALESCE(NULLIF(oi.product_name_snapshot, ''), p.name) AS name, p.image_url
     FROM order_items oi
     LEFT JOIN products p ON oi.product_id = p.id
     WHERE oi.order_id = ?`,
    [id]
  );
  let items = normalizeResult(itemsResult);
  
  // Generate presigned URLs for item images
  items = await Promise.all(
    items.map(async (item) => ({
      ...item,
      image_url: item.image_url ? await getPresignedUrl(item.image_url, 3600) : null,
    }))
  );
  
  res.json({
    order: {
      ...order,
      shipping_address: JSON.parse(order.shipping_address || '{}'),
    },
    items
  });
}));

// Cancel an order (requires authentication)
router.put('/:id/cancel', authMiddleware, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  
  // Get order and verify it belongs to user
  const orderResult = await db.query(
    `SELECT * FROM orders WHERE id = ? AND user_id = ?`,
    [id, userId]
  );
  const orders = normalizeResult(orderResult);
  
  if (orders.length === 0) {
    return res.status(404).json({ message: 'Order not found' });
  }
  
  const order = orders[0];
  
  // Check if order can be cancelled
  if (order.status === 'cancelled') {
    return res.status(400).json({ message: 'Order is already cancelled' });
  }
  
  if (order.status === 'completed' || order.status === 'shipped') {
    return res.status(400).json({ message: 'Cannot cancel a completed or shipped order' });
  }
  
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Restore stock for all order items
    const itemsResult = await connection.query(
      `SELECT product_id, quantity FROM order_items WHERE order_id = ?`,
      [id]
    );
    const items = normalizeResult(itemsResult);
    
    for (const item of items) {
      await connection.query(
        `UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?`,
        [item.quantity, item.product_id]
      );
    }
    
    // Update order status to cancelled
    await connection.query(
      `UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ?`,
      ['cancelled', id]
    );
    
    await connection.commit();
    
    res.json({ 
      message: 'Order cancelled successfully',
      orderId: id
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error cancelling order:', error);
    throw error;
  } finally {
    connection.release();
  }
}));

export default router;
