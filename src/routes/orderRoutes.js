import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { db } from '../config/db.js';

const router = express.Router();

// Helper to normalize query results to array
const normalizeResult = (result) => {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    if (result.id !== undefined || result.order_number !== undefined) {
      return [result];
    }
  }
  return [];
};

// Get user's orders
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await db.query(
      `SELECT o.*, 
        COUNT(oi.id) as item_count,
        (SELECT p.name FROM products p 
         JOIN order_items oi2 ON p.id = oi2.product_id 
         WHERE oi2.order_id = o.id LIMIT 1) as product_name,
        (SELECT p.image_url FROM products p 
         JOIN order_items oi2 ON p.id = oi2.product_id 
         WHERE oi2.order_id = o.id LIMIT 1) as image_url
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.user_id = ?
      GROUP BY o.id
      ORDER BY o.created_at DESC`,
      [userId]
    );
    
    const orders = normalizeResult(result);
    
    res.json({ 
      success: true, 
      orders 
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch orders' 
    });
  }
});

// Get single order with items
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const orderId = req.params.id;
    
    // Get order
    const orderResult = await db.query(
      'SELECT * FROM orders WHERE id = ? AND user_id = ?',
      [orderId, userId]
    );
    
    const orders = normalizeResult(orderResult);
    
    if (orders.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Order not found' 
      });
    }
    
    // Get order items
    const itemResult = await db.query(
      `SELECT oi.*, p.name, p.image_url 
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = ?`,
      [orderId]
    );
    
    const items = normalizeResult(itemResult);
    
    res.json({
      success: true,
      order: orders[0],
      items
    });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch order' 
    });
  }
});

// Create new order
router.post('/', authMiddleware, async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const userId = req.user.id;
    const { items, total, shipping_address } = req.body;
    
    if (!items || !items.length) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'No items in order' 
      });
    }
    
    // Generate order number
    const orderNumber = 'ORD-' + Date.now();
    
    // Create order
    const orderResult = await connection.query(
      `INSERT INTO orders (user_id, order_number, total_amount, shipping_address, status) 
       VALUES (?, ?, ?, ?, 'pending')`,
      [userId, orderNumber, total, shipping_address]
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
        'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?',
        [item.quantity, item.product_id]
      );
    }
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Order created successfully',
      order: {
        id: orderId,
        order_number: orderNumber,
        total_amount: total,
        status: 'pending'
      }
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating order:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create order' 
    });
  } finally {
    connection.release();
  }
});

export default router;
