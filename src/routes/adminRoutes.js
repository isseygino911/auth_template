import express from 'express';
import {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  getCategories,
  getUploadUrl,
  getOrders,
  getOrder,
  updateOrderStatus,
  getDashboardStats,
} from '../controllers/adminController.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// All admin routes require authentication
router.use(authMiddleware);

// Dashboard stats
router.get('/dashboard', getDashboardStats);

// Products
router.get('/products', getProducts);
router.get('/products/categories', getCategories);
router.post('/products/upload-url', getUploadUrl);
router.get('/products/:id', getProduct);
router.post('/products', createProduct);
router.put('/products/:id', updateProduct);
router.delete('/products/:id', deleteProduct);

// Orders
router.get('/orders', getOrders);
router.get('/orders/:id', getOrder);
router.put('/orders/:id/status', updateOrderStatus);

export default router;
