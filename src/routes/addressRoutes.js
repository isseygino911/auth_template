import express from 'express';
import { db } from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { normalizeResult } from '../utils/helpers.js';

const router = express.Router();

// Get all addresses for current user
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  
  const result = await db.query(
    `SELECT id, label, recipient_name, street_address, city, state, 
            postal_code, country, phone, is_default, created_at
     FROM addresses 
     WHERE user_id = ? 
     ORDER BY is_default DESC, created_at DESC`,
    [userId]
  );
  
  const addresses = normalizeResult(result);
  res.json({ addresses });
}));

// Get single address
router.get('/:id', authMiddleware, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  
  const result = await db.query(
    `SELECT id, label, recipient_name, street_address, city, state, 
            postal_code, country, phone, is_default, created_at
     FROM addresses 
     WHERE id = ? AND user_id = ?`,
    [id, userId]
  );
  
  const addresses = normalizeResult(result);
  
  if (addresses.length === 0) {
    return res.status(404).json({ message: 'Address not found' });
  }
  
  res.json({ address: addresses[0] });
}));

// Create new address
router.post('/', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  let { 
    label = 'Home', 
    recipient_name, 
    street_address, 
    city, 
    state = '', 
    postal_code, 
    country = 'Malaysia',
    phone = '',
    is_default = false
  } = req.body;
  
  // Ensure is_default is boolean
  is_default = is_default === true || is_default === 'true' ? 1 : 0;
  
  // Validate required fields
  if (!recipient_name || !street_address || !city || !postal_code) {
    return res.status(400).json({ 
      message: 'Recipient name, street address, city, and postal code are required' 
    });
  }
  
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // If setting as default, unset other defaults first
    if (is_default) {
      await connection.query(
        'UPDATE addresses SET is_default = FALSE WHERE user_id = ?',
        [userId]
      );
    }
    
    // Insert new address
    const result = await connection.query(
      `INSERT INTO addresses 
       (user_id, label, recipient_name, street_address, city, state, postal_code, country, phone, is_default) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, label, recipient_name, street_address, city, state, postal_code, country, phone, is_default]
    );
    
    await connection.commit();
    
    const newAddress = await db.query(
      `SELECT id, label, recipient_name, street_address, city, state, 
              postal_code, country, phone, is_default, created_at
       FROM addresses 
       WHERE id = ?`,
      [result.insertId]
    );
    
    res.status(201).json({ 
      message: 'Address created successfully',
      address: normalizeResult(newAddress)[0]
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// Update address
router.put('/:id', authMiddleware, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  const { 
    label, 
    recipient_name, 
    street_address, 
    city, 
    state, 
    postal_code, 
    country,
    phone,
    is_default
  } = req.body;
  
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Check if address exists and belongs to user
    const existing = await connection.query(
      'SELECT id FROM addresses WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    
    if (normalizeResult(existing).length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: 'Address not found' });
    }
    
    // If setting as default, unset other defaults first
    if (is_default) {
      await connection.query(
        'UPDATE addresses SET is_default = FALSE WHERE user_id = ? AND id != ?',
        [userId, id]
      );
    }
    
    // Build update query dynamically
    const updates = [];
    const values = [];
    
    if (label !== undefined) { updates.push('label = ?'); values.push(label); }
    if (recipient_name !== undefined) { updates.push('recipient_name = ?'); values.push(recipient_name); }
    if (street_address !== undefined) { updates.push('street_address = ?'); values.push(street_address); }
    if (city !== undefined) { updates.push('city = ?'); values.push(city); }
    if (state !== undefined) { updates.push('state = ?'); values.push(state); }
    if (postal_code !== undefined) { updates.push('postal_code = ?'); values.push(postal_code); }
    if (country !== undefined) { updates.push('country = ?'); values.push(country); }
    if (phone !== undefined) { updates.push('phone = ?'); values.push(phone); }
    if (is_default !== undefined) { 
      const isDefaultValue = is_default === true || is_default === 'true' ? 1 : 0;
      updates.push('is_default = ?'); 
      values.push(isDefaultValue); 
    }
    
    if (updates.length === 0) {
      await connection.rollback();
      return res.status(400).json({ message: 'No fields to update' });
    }
    
    values.push(id, userId);
    
    await connection.query(
      `UPDATE addresses SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
      values
    );
    
    await connection.commit();
    
    const updatedAddress = await db.query(
      `SELECT id, label, recipient_name, street_address, city, state, 
              postal_code, country, phone, is_default, created_at
       FROM addresses 
       WHERE id = ?`,
      [id]
    );
    
    res.json({ 
      message: 'Address updated successfully',
      address: normalizeResult(updatedAddress)[0]
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// Delete address
router.delete('/:id', authMiddleware, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  
  const result = await db.query(
    'DELETE FROM addresses WHERE id = ? AND user_id = ?',
    [id, userId]
  );
  
  if (result.affectedRows === 0) {
    return res.status(404).json({ message: 'Address not found' });
  }
  
  res.json({ message: 'Address deleted successfully' });
}));

// Set address as default
router.patch('/:id/default', authMiddleware, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Check if address exists and belongs to user
    const existing = await connection.query(
      'SELECT id FROM addresses WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    
    if (normalizeResult(existing).length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: 'Address not found' });
    }
    
    // Unset all other defaults
    await connection.query(
      'UPDATE addresses SET is_default = FALSE WHERE user_id = ?',
      [userId]
    );
    
    // Set this one as default
    await connection.query(
      'UPDATE addresses SET is_default = TRUE WHERE id = ?',
      [id]
    );
    
    await connection.commit();
    
    res.json({ message: 'Default address updated successfully' });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

export default router;
