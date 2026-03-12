import express from 'express';
import { db } from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

const router = express.Router();

// Helper to normalize query results
const normalizeResult = (result) => {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    if (result.id !== undefined) return [result];
  }
  return [];
};

// Helper to generate order number
const generateOrderNumber = () => {
  return 'ORD-' + Date.now().toString(36).toUpperCase();
};

// Create a new order (requires authentication)
router.post('/', authMiddleware, asyncHandler(async (req, res) => {
  const { items, shipping_address, total_amount } = req.body;
  const userId = req.user.userId;
  
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Order items are required' });
  }
  
  if (!shipping_address) {
    return res.status(400).json({ message: 'Shipping address is required' });
  }
  
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Generate order number
    const orderNumber = generateOrderNumber();
    
    // Create order
    const orderResult = await connection.query(
      `INSERT INTO orders (order_number, user_id, total_amount, status, shipping_address) 
       VALUES (?, ?, ?, ?, ?)`,
      [orderNumber, userId, total_amount, 'pending', JSON.stringify(shipping_address)]
    );
    
    const orderId = orderResult.insertId;
    
    // Create order items
    for (const item of items) {
      await connection.query(
        `INSERT INTO order_items (order_id, product_id, quantity, price_at_time) 
         VALUES (?, ?, ?, ?)`,
        [orderId, item.product_id, item.quantity, item.price]
      );
      
      // Update product stock
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
// Alias for /my-orders, also available at root path for convenience
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  
  const result = await db.query(
    `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
  const orders = normalizeResult(result);
  
  // Parse shipping address for each order
  const ordersWithParsedAddress = orders.map(order => ({
    ...order,
    shipping_address: JSON.parse(order.shipping_address || '{}'),
  }));
  
  res.json({ orders: ordersWithParsedAddress });
}));

// Get current user's orders (alternative path)
router.get('/my-orders', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  
  const result = await db.query(
    `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
  const orders = normalizeResult(result);
  
  // Parse shipping address for each order
  const ordersWithParsedAddress = orders.map(order => ({
    ...order,
    shipping_address: JSON.parse(order.shipping_address || '{}'),
  }));
  
  res.json({ orders: ordersWithParsedAddress });
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
    `SELECT oi.*, p.name, p.image_url 
     FROM order_items oi 
     JOIN products p ON oi.product_id = p.id 
     WHERE oi.order_id = ?`,
    [id]
  );
  const items = normalizeResult(itemsResult);
  
  res.json({
    order: {
      ...order,
      shipping_address: JSON.parse(order.shipping_address || '{}'),
    },
    items
  });
}));

export default router;
