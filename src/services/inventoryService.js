import { db } from '../config/db.js';
import { normalizeResult } from '../utils/helpers.js';

/**
 * Custom error class for insufficient stock scenarios
 */
export class InsufficientStockError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'InsufficientStockError';
    this.statusCode = 400;
    this.details = details;
  }
}

/**
 * Reserve stock for an order with transaction safety.
 * Uses FOR UPDATE locking to prevent race conditions.
 *
 * Expected inventory_reservations table:
 * - id: INT UNSIGNED AUTO_INCREMENT PRIMARY KEY
 * - product_id: INT UNSIGNED NOT NULL (FK to products.id)
 * - order_id: INT UNSIGNED NOT NULL (FK to orders.id)
 * - quantity: INT UNSIGNED NOT NULL
 * - expires_at: TIMESTAMP NOT NULL
 * - created_at: TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 *
 * Expected inventory_transactions table:
 * - id: INT UNSIGNED AUTO_INCREMENT PRIMARY KEY
 * - product_id: INT UNSIGNED NOT NULL (FK to products.id)
 * - order_id: INT UNSIGNED NULL (FK to orders.id)
 * - quantity: INT NOT NULL (positive for stock in, negative for stock out)
 * - type: ENUM('reservation', 'sale', 'cancellation', 'adjustment', 'release') NOT NULL
 * - reason: VARCHAR(255) NULL
 * - created_by: INT UNSIGNED NULL (FK to users.id)
 * - created_at: TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 *
 * @param {number} productId - The product ID to reserve stock for
 * @param {number} orderId - The order ID associated with the reservation
 * @param {number} quantity - The quantity to reserve
 * @param {number} expireMinutes - Minutes until the reservation expires (default: 30)
 * @returns {Promise<Object>} The created reservation object
 * @throws {InsufficientStockError} When available stock is insufficient
 */
export async function reserveStock(productId, orderId, quantity, expireMinutes = 30) {
  if (!productId || !orderId || !quantity || quantity <= 0) {
    throw new Error('Invalid parameters: productId, orderId, and positive quantity are required');
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    // Lock the product row to prevent race conditions
    const [product] = await connection.query(
      `SELECT id, name, stock_quantity FROM products WHERE id = ? FOR UPDATE`,
      [productId]
    );

    if (!product) {
      await connection.rollback();
      throw new Error(`Product ID ${productId} not found`);
    }

    // Calculate total reserved quantity for this product (excluding current order)
    const [reservationRow] = await connection.query(
      `SELECT COALESCE(SUM(quantity), 0) as reserved 
       FROM inventory_reservations 
       WHERE product_id = ? 
       AND order_id != ? 
       AND expires_at > NOW()`,
      [productId, orderId]
    );

    const reservedQuantity = parseInt(reservationRow?.reserved || 0, 10);
    const physicalStock = parseInt(product.stock_quantity || 0, 10);
    const availableStock = physicalStock - reservedQuantity;

    if (availableStock < quantity) {
      await connection.rollback();
      throw new InsufficientStockError(
        `Insufficient stock for product "${product.name}". Available: ${availableStock}, Requested: ${quantity}`,
        {
          productId,
          productName: product.name,
          availableStock,
          requestedQuantity: quantity,
          physicalStock,
          reservedQuantity,
        }
      );
    }

    // Check if there's an existing reservation for this product + order
    const [existingReservation] = await connection.query(
      `SELECT id, quantity FROM inventory_reservations WHERE product_id = ? AND order_id = ?`,
      [productId, orderId]
    );

    let reservationId;
    const expiresAt = new Date(Date.now() + expireMinutes * 60000);

    if (existingReservation) {
      // Update existing reservation by adding the new quantity
      const newQuantity = parseInt(existingReservation.quantity, 10) + quantity;
      const updateResult = await connection.query(
        `UPDATE inventory_reservations 
         SET quantity = ?, expires_at = ? 
         WHERE id = ?`,
        [newQuantity, expiresAt, existingReservation.id]
      );
      reservationId = existingReservation.id;
    } else {
      // Create new reservation
      const insertResult = await connection.query(
        `INSERT INTO inventory_reservations (product_id, order_id, quantity, expires_at) 
         VALUES (?, ?, ?, ?)`,
        [productId, orderId, quantity, expiresAt]
      );
      reservationId = insertResult.insertId;
    }

    // Record the transaction
    await connection.query(
      `INSERT INTO inventory_transactions 
       (product_id, order_id, quantity, type, reason, created_at) 
       VALUES (?, ?, ?, 'reservation', ?, NOW())`,
      [productId, orderId, quantity, `Stock reserved for order ${orderId}`]
    );

    await connection.commit();

    // Fetch and return the reservation
    const result = await db.query(
      `SELECT * FROM inventory_reservations WHERE id = ?`,
      [reservationId]
    );
    const reservations = normalizeResult(result);

    return reservations[0];
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Confirm all reservations for an order and deduct stock.
 * Removes reservations, deducts stock from products, and creates transaction records.
 *
 * @param {number} orderId - The order ID to confirm reservations for
 * @returns {Promise<Object>} Summary of changes { orderId, items: [...], totalDeducted }
 */
export async function confirmReservation(orderId) {
  if (!orderId) {
    throw new Error('Invalid parameter: orderId is required');
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    // Get all reservations for this order
    const reservationsResult = await connection.query(
      `SELECT * FROM inventory_reservations WHERE order_id = ? AND expires_at > NOW()`,
      [orderId]
    );
    const reservations = normalizeResult(reservationsResult);

    if (reservations.length === 0) {
      await connection.rollback();
      return {
        orderId,
        items: [],
        totalDeducted: 0,
        message: 'No active reservations found for this order',
      };
    }

    const items = [];
    let totalDeducted = 0;

    for (const reservation of reservations) {
      const productId = reservation.product_id;
      const quantity = parseInt(reservation.quantity, 10);

      // Lock the product row
      const [product] = await connection.query(
        `SELECT id, name, stock_quantity FROM products WHERE id = ? FOR UPDATE`,
        [productId]
      );

      if (!product) {
        await connection.rollback();
        throw new Error(`Product ID ${productId} not found during confirmation`);
      }

      // Verify sufficient stock
      if (parseInt(product.stock_quantity, 10) < quantity) {
        await connection.rollback();
        throw new InsufficientStockError(
          `Insufficient stock for product "${product.name}" during confirmation`,
          {
            productId,
            productName: product.name,
            availableStock: product.stock_quantity,
            requestedQuantity: quantity,
          }
        );
      }

      // Deduct stock from product
      await connection.query(
        `UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?`,
        [quantity, productId]
      );

      // Remove the reservation
      await connection.query(
        `DELETE FROM inventory_reservations WHERE id = ?`,
        [reservation.id]
      );

      // Create sale transaction record
      await connection.query(
        `INSERT INTO inventory_transactions 
         (product_id, order_id, quantity, type, reason, created_at) 
         VALUES (?, ?, ?, 'sale', ?, NOW())`,
        [productId, orderId, -quantity, `Stock deducted for confirmed order ${orderId}`]
      );

      items.push({
        productId,
        productName: product.name,
        quantity,
      });

      totalDeducted += quantity;
    }

    await connection.commit();

    return {
      orderId,
      items,
      totalDeducted,
      message: `Successfully confirmed ${items.length} item(s)`,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Release all reservations for an order without deducting stock.
 * Removes all reservations and creates release transaction records.
 *
 * @param {number} orderId - The order ID to release reservations for
 * @returns {Promise<Object>} Released quantities per product
 */
export async function releaseReservation(orderId) {
  if (!orderId) {
    throw new Error('Invalid parameter: orderId is required');
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    // Get all reservations for this order
    const reservationsResult = await connection.query(
      `SELECT * FROM inventory_reservations WHERE order_id = ?`,
      [orderId]
    );
    const reservations = normalizeResult(reservationsResult);

    if (reservations.length === 0) {
      await connection.rollback();
      return {
        orderId,
        releasedProducts: [],
        totalReleased: 0,
        message: 'No reservations found for this order',
      };
    }

    const releasedProducts = [];
    let totalReleased = 0;

    for (const reservation of reservations) {
      const productId = reservation.product_id;
      const quantity = parseInt(reservation.quantity, 10);

      // Get product name for the record
      const [product] = await connection.query(
        `SELECT name FROM products WHERE id = ?`,
        [productId]
      );

      // Remove the reservation
      await connection.query(
        `DELETE FROM inventory_reservations WHERE id = ?`,
        [reservation.id]
      );

      // Create release transaction record
      await connection.query(
        `INSERT INTO inventory_transactions 
         (product_id, order_id, quantity, type, reason, created_at) 
         VALUES (?, ?, ?, 'release', ?, NOW())`,
        [productId, orderId, quantity, `Stock reservation released for order ${orderId}`]
      );

      releasedProducts.push({
        productId,
        productName: product?.name || 'Unknown',
        quantity,
      });

      totalReleased += quantity;
    }

    await connection.commit();

    return {
      orderId,
      releasedProducts,
      totalReleased,
      message: `Successfully released ${releasedProducts.length} reservation(s)`,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Adjust stock quantity manually (admin operation).
 * Creates a transaction record and updates product stock.
 *
 * @param {number} productId - The product ID to adjust
 * @param {number} quantity - The quantity to adjust (positive for increase, negative for decrease)
 * @param {string} reason - The reason for the adjustment
 * @param {number} userId - The admin user ID making the adjustment
 * @returns {Promise<Object>} New stock level and adjustment details
 */
export async function adjustStock(productId, quantity, reason, userId) {
  if (!productId || quantity === undefined || quantity === null) {
    throw new Error('Invalid parameters: productId and quantity are required');
  }

  if (!reason || reason.trim() === '') {
    throw new Error('Invalid parameter: reason is required');
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    // Lock the product row
    const [product] = await connection.query(
      `SELECT id, name, stock_quantity FROM products WHERE id = ? FOR UPDATE`,
      [productId]
    );

    if (!product) {
      await connection.rollback();
      throw new Error(`Product ID ${productId} not found`);
    }

    const currentStock = parseInt(product.stock_quantity || 0, 10);
    const newStock = currentStock + quantity;

    if (newStock < 0) {
      await connection.rollback();
      throw new InsufficientStockError(
        `Cannot reduce stock below zero. Current: ${currentStock}, Adjustment: ${quantity}`,
        {
          productId,
          productName: product.name,
          currentStock,
          adjustment: quantity,
          wouldResultIn: newStock,
        }
      );
    }

    // Update product stock
    await connection.query(
      `UPDATE products SET stock_quantity = ? WHERE id = ?`,
      [newStock, productId]
    );

    // Create adjustment transaction record
    await connection.query(
      `INSERT INTO inventory_transactions 
       (product_id, quantity, type, reason, created_by, created_at) 
       VALUES (?, ?, 'adjustment', ?, ?, NOW())`,
      [productId, quantity, reason, userId]
    );

    await connection.commit();

    return {
      productId,
      productName: product.name,
      previousStock: currentStock,
      adjustment: quantity,
      newStock,
      reason,
      adjustedBy: userId,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Restore stock when an order is cancelled.
 * Gets order items and restores stock for each item.
 *
 * @param {number} orderId - The cancelled order ID
 * @param {number} userId - The user ID performing the cancellation (optional)
 * @returns {Promise<Object>} Restoration summary
 */
export async function restoreStockOnCancellation(orderId, userId = null) {
  if (!orderId) {
    throw new Error('Invalid parameter: orderId is required');
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    // Get order items
    const itemsResult = await connection.query(
      `SELECT oi.*, p.name as product_name 
       FROM order_items oi 
       LEFT JOIN products p ON oi.product_id = p.id 
       WHERE oi.order_id = ?`,
      [orderId]
    );
    const items = normalizeResult(itemsResult);

    if (items.length === 0) {
      await connection.rollback();
      return {
        orderId,
        restoredItems: [],
        totalRestored: 0,
        message: 'No items found for this order',
      };
    }

    const restoredItems = [];
    let totalRestored = 0;

    for (const item of items) {
      const productId = item.product_id;
      const quantity = parseInt(item.quantity, 10);

      if (!productId) {
        // Skip items where product was deleted
        restoredItems.push({
          productId: null,
          productName: item.product_name_snapshot || 'Deleted Product',
          quantity,
          skipped: true,
          reason: 'Product no longer exists',
        });
        continue;
      }

      // Lock the product row
      const [product] = await connection.query(
        `SELECT id, name, stock_quantity FROM products WHERE id = ? FOR UPDATE`,
        [productId]
      );

      if (!product) {
        restoredItems.push({
          productId,
          productName: item.product_name_snapshot || 'Unknown',
          quantity,
          skipped: true,
          reason: 'Product not found',
        });
        continue;
      }

      const currentStock = parseInt(product.stock_quantity || 0, 10);
      const newStock = currentStock + quantity;

      // Restore stock
      await connection.query(
        `UPDATE products SET stock_quantity = ? WHERE id = ?`,
        [newStock, productId]
      );

      // Create cancellation transaction record
      await connection.query(
        `INSERT INTO inventory_transactions 
         (product_id, order_id, quantity, type, reason, created_by, created_at) 
         VALUES (?, ?, ?, 'cancellation', ?, ?, NOW())`,
        [productId, orderId, quantity, `Stock restored for cancelled order ${orderId}`, userId]
      );

      restoredItems.push({
        productId,
        productName: product.name,
        quantity,
        previousStock: currentStock,
        newStock,
        skipped: false,
      });

      totalRestored += quantity;
    }

    // Also release any pending reservations for this order
    await connection.query(
      `DELETE FROM inventory_reservations WHERE order_id = ?`,
      [orderId]
    );

    await connection.commit();

    return {
      orderId,
      restoredItems,
      totalRestored,
      message: `Successfully restored stock for ${restoredItems.filter(i => !i.skipped).length} item(s)`,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Get available stock for a product (physical stock minus reserved).
 *
 * @param {number} productId - The product ID
 * @returns {Promise<number>} Available stock quantity
 */
export async function getAvailableStock(productId) {
  if (!productId) {
    throw new Error('Invalid parameter: productId is required');
  }

  const result = await db.query(
    `SELECT 
       p.stock_quantity as physical_stock,
       COALESCE(SUM(r.quantity), 0) as reserved_quantity
     FROM products p
     LEFT JOIN inventory_reservations r 
       ON p.id = r.product_id 
       AND r.expires_at > NOW()
     WHERE p.id = ?
     GROUP BY p.id`,
    [productId]
  );

  const rows = normalizeResult(result);

  if (rows.length === 0) {
    throw new Error(`Product ID ${productId} not found`);
  }

  const physicalStock = parseInt(rows[0].physical_stock || 0, 10);
  const reservedQuantity = parseInt(rows[0].reserved_quantity || 0, 10);

  return physicalStock - reservedQuantity;
}

/**
 * Get total reserved quantity for a product (sum of non-expired reservations).
 *
 * @param {number} productId - The product ID
 * @returns {Promise<number>} Total reserved quantity
 */
export async function getReservedQuantity(productId) {
  if (!productId) {
    throw new Error('Invalid parameter: productId is required');
  }

  const result = await db.query(
    `SELECT COALESCE(SUM(quantity), 0) as reserved 
     FROM inventory_reservations 
     WHERE product_id = ? AND expires_at > NOW()`,
    [productId]
  );

  const rows = normalizeResult(result);
  return parseInt(rows[0]?.reserved || 0, 10);
}

/**
 * Clean up expired reservations.
 * Deletes reservations where expires_at < NOW().
 *
 * @returns {Promise<Object>} Count of cleaned reservations and details
 */
export async function cleanupExpiredReservations() {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    // Get expired reservations before deleting (for the record)
    const expiredResult = await connection.query(
      `SELECT * FROM inventory_reservations WHERE expires_at < NOW()`
    );
    const expired = normalizeResult(expiredResult);

    if (expired.length === 0) {
      await connection.rollback();
      return {
        cleanedCount: 0,
        releasedProducts: [],
        message: 'No expired reservations found',
      };
    }

    // Create release transaction records for audit trail
    for (const reservation of expired) {
      await connection.query(
        `INSERT INTO inventory_transactions 
         (product_id, order_id, quantity, type, reason, created_at) 
         VALUES (?, ?, ?, 'release', ?, NOW())`,
        [
          reservation.product_id,
          reservation.order_id,
          reservation.quantity,
          `Expired reservation auto-cleaned (was reserved for order ${reservation.order_id})`,
        ]
      );
    }

    // Delete expired reservations
    const deleteResult = await connection.query(
      `DELETE FROM inventory_reservations WHERE expires_at < NOW()`
    );

    await connection.commit();

    // Group by product for summary
    const releasedProducts = expired.reduce((acc, r) => {
      const existing = acc.find(p => p.productId === r.product_id);
      if (existing) {
        existing.quantity += parseInt(r.quantity, 10);
      } else {
        acc.push({
          productId: r.product_id,
          quantity: parseInt(r.quantity, 10),
        });
      }
      return acc;
    }, []);

    return {
      cleanedCount: expired.length,
      affectedRows: deleteResult.affectedRows,
      releasedProducts,
      message: `Successfully cleaned ${expired.length} expired reservation(s)`,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Get paginated transaction history for a product.
 *
 * @param {number} productId - The product ID
 * @param {Object} options - Pagination options
 * @param {number} options.page - Page number (1-based, default: 1)
 * @param {number} options.limit - Items per page (default: 20)
 * @param {string} options.type - Filter by transaction type (optional)
 * @returns {Promise<Object>} Paginated transaction history
 */
export async function getTransactionHistory(productId, options = {}) {
  if (!productId) {
    throw new Error('Invalid parameter: productId is required');
  }

  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE t.product_id = ?';
  const params = [productId];

  if (options.type) {
    whereClause += ' AND t.type = ?';
    params.push(options.type);
  }

  // Get total count
  const countResult = await db.query(
    `SELECT COUNT(*) as total FROM inventory_transactions t ${whereClause}`,
    params
  );
  const countRows = normalizeResult(countResult);
  const total = parseInt(countRows[0]?.total || 0, 10);

  // Get transactions
  const transactionsResult = await db.query(
    `SELECT 
       t.*,
       p.name as product_name,
       u.email as created_by_email
     FROM inventory_transactions t
     LEFT JOIN products p ON t.product_id = p.id
     LEFT JOIN users u ON t.created_by = u.id
     ${whereClause}
     ORDER BY t.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const transactions = normalizeResult(transactionsResult);

  return {
    productId,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page < Math.ceil(total / limit),
      hasPrev: page > 1,
    },
    transactions: transactions.map(t => ({
      id: t.id,
      productId: t.product_id,
      productName: t.product_name,
      orderId: t.order_id,
      quantity: t.quantity,
      type: t.type,
      reason: t.reason,
      createdBy: t.created_by,
      createdByEmail: t.created_by_email,
      createdAt: t.created_at,
    })),
  };
}
