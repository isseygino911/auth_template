import express from 'express';
import { db } from '../config/db.js';
import { authMiddleware, adminMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { normalizeResult } from '../utils/helpers.js';
import * as inventoryService from '../services/inventoryService.js';

const router = express.Router();

// All inventory routes require authentication AND admin privileges
router.use(authMiddleware);
router.use(adminMiddleware);

/**
 * GET /api/admin/inventory/transactions
 * Get paginated transaction history with optional filtering
 */
router.get('/transactions', asyncHandler(async (req, res) => {
  const { product_id, type, page = 1, limit = 20 } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * limitNum;

  let whereClause = 'WHERE 1=1';
  const params = [];

  if (product_id) {
    whereClause += ' AND t.product_id = ?';
    params.push(product_id);
  }

  if (type) {
    whereClause += ' AND t.type = ?';
    params.push(type);
  }

  // Get total count
  const countResult = await db.query(
    `SELECT COUNT(*) as total FROM inventory_transactions t ${whereClause}`,
    params
  );
  const total = normalizeResult(countResult)[0]?.total || 0;

  // Get transactions with product info
  const transactionsResult = await db.query(
    `SELECT 
      t.id,
      t.product_id,
      p.name as product_name,
      t.type,
      t.quantity,
      t.previous_quantity,
      t.new_quantity,
      t.reason,
      t.reference_id,
      t.reference_type,
      t.created_by,
      u.email as created_by_email,
      t.created_at
    FROM inventory_transactions t
    JOIN products p ON t.product_id = p.id
    LEFT JOIN users u ON t.created_by = u.id
    ${whereClause}
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?`,
    [...params, limitNum, offset]
  );

  const transactions = normalizeResult(transactionsResult);

  res.json({
    transactions,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
      hasMore: pageNum * limitNum < total,
    },
  });
}));

/**
 * POST /api/admin/inventory/adjust
 * Adjust stock quantity for a product
 */
router.post('/adjust', asyncHandler(async (req, res) => {
  const { product_id, quantity, reason } = req.body;

  if (!product_id) {
    return res.status(400).json({ message: 'Product ID is required' });
  }

  if (quantity === undefined || quantity === null) {
    return res.status(400).json({ message: 'Quantity is required' });
  }

  if (!reason || reason.trim() === '') {
    return res.status(400).json({ message: 'Reason is required' });
  }

  const quantityNum = parseInt(quantity, 10);
  if (isNaN(quantityNum)) {
    return res.status(400).json({ message: 'Quantity must be a valid number' });
  }

  // Call inventory service to adjust stock
  const updatedProduct = await inventoryService.adjustStock(
    product_id,
    quantityNum,
    reason,
    req.user.id
  );

  res.json({
    message: 'Stock adjusted successfully',
    product: updatedProduct,
  });
}));

/**
 * GET /api/admin/inventory/low-stock
 * Get products below their alert threshold
 */
router.get('/low-stock', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT 
      p.id,
      p.name,
      p.stock_quantity as current_stock,
      COALESCE(ias.alert_threshold, 10) as threshold,
      COALESCE(ias.alert_threshold, 10) - p.stock_quantity as deficit
    FROM products p
    LEFT JOIN inventory_alert_settings ias ON p.id = ias.product_id
    WHERE p.stock_quantity <= COALESCE(ias.alert_threshold, 10)
      AND p.status = 'active'
    ORDER BY deficit DESC`
  );

  const lowStockProducts = normalizeResult(result);

  res.json({
    products: lowStockProducts,
    count: lowStockProducts.length,
  });
}));

/**
 * GET /api/admin/inventory/reservations
 * Get current reservations with product and order info
 */
router.get('/reservations', asyncHandler(async (req, res) => {
  const { active_only = 'true' } = req.query;
  const isActiveOnly = active_only === 'true';

  let whereClause = '';
  if (isActiveOnly) {
    whereClause = "WHERE ir.status = 'active'";
  }

  const result = await db.query(
    `SELECT 
      ir.id,
      ir.product_id,
      p.name as product_name,
      ir.order_id,
      o.order_number,
      ir.quantity,
      ir.status,
      ir.expires_at,
      ir.created_at,
      u.email as customer_email
    FROM inventory_reservations ir
    JOIN products p ON ir.product_id = p.id
    JOIN orders o ON ir.order_id = o.id
    LEFT JOIN users u ON o.user_id = u.id
    ${whereClause}
    ORDER BY ir.created_at DESC`
  );

  const reservations = normalizeResult(result);

  res.json({
    reservations,
    count: reservations.length,
    activeOnly: isActiveOnly,
  });
}));

/**
 * GET /api/admin/inventory/product/:productId
 * Get detailed inventory status for a specific product
 */
router.get('/product/:productId', asyncHandler(async (req, res) => {
  const { productId } = req.params;

  // Get product basic info
  const productResult = await db.query(
    `SELECT 
      id,
      name,
      stock_quantity,
      status
    FROM products
    WHERE id = ?`,
    [productId]
  );

  const products = normalizeResult(productResult);
  if (products.length === 0) {
    return res.status(404).json({ message: 'Product not found' });
  }

  const product = products[0];

  // Get alert settings
  const alertResult = await db.query(
    `SELECT 
      alert_threshold,
      auto_notify,
      notify_email,
      created_at,
      updated_at
    FROM inventory_alert_settings
    WHERE product_id = ?`,
    [productId]
  );

  const alertSettings = normalizeResult(alertResult)[0] || null;

  // Calculate reserved quantity
  const reservedResult = await db.query(
    `SELECT 
      COALESCE(SUM(quantity), 0) as total_reserved
    FROM inventory_reservations
    WHERE product_id = ? AND status = 'active'`,
    [productId]
  );

  const reservedQuantity = normalizeResult(reservedResult)[0]?.total_reserved || 0;

  // Get recent transactions (last 10)
  const transactionsResult = await db.query(
    `SELECT 
      t.id,
      t.type,
      t.quantity,
      t.previous_quantity,
      t.new_quantity,
      t.reason,
      t.reference_id,
      t.reference_type,
      t.created_at,
      u.email as created_by_email
    FROM inventory_transactions t
    LEFT JOIN users u ON t.created_by = u.id
    WHERE t.product_id = ?
    ORDER BY t.created_at DESC
    LIMIT 10`,
    [productId]
  );

  const recentTransactions = normalizeResult(transactionsResult);

  res.json({
    product: {
      id: product.id,
      name: product.name,
      physical_stock: product.stock_quantity,
      reserved_quantity: reservedQuantity,
      available_stock: Math.max(0, product.stock_quantity - reservedQuantity),
      status: product.status,
    },
    alert_settings: alertSettings,
    recent_transactions: recentTransactions,
  });
}));

export default router;
