import express from 'express';
import {
  getFolders,
  getAllFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  getDocuments,
  getAllDocuments,
  getDocument,
  getUploadUrl,
  createDocument,
  updateDocument,
  deleteDocument,
  incrementDownloadCount,
} from '../controllers/documentController.js';
import { authMiddleware, adminMiddleware } from '../middleware/auth.js';

const router = express.Router();

// ==================== PUBLIC ROUTES ====================
// These routes are accessible without authentication (for Tools page)

// Get active folders
router.get('/folders', getFolders);

// Get active documents
router.get('/', getDocuments);

// Get single document
router.get('/:id', getDocument);

// Increment download count
router.post('/:id/download', incrementDownloadCount);

// ==================== ADMIN ROUTES ====================
// These routes require authentication AND admin privileges

// Folders management
router.get('/admin/folders', authMiddleware, adminMiddleware, getAllFolders);
router.post('/admin/folders', authMiddleware, adminMiddleware, createFolder);
router.put('/admin/folders/:id', authMiddleware, adminMiddleware, updateFolder);
router.delete('/admin/folders/:id', authMiddleware, adminMiddleware, deleteFolder);

// Documents management
router.get('/admin/all', authMiddleware, adminMiddleware, getAllDocuments);
router.post('/admin/upload-url', authMiddleware, adminMiddleware, getUploadUrl);
router.post('/admin', authMiddleware, adminMiddleware, createDocument);
router.put('/admin/:id', authMiddleware, adminMiddleware, updateDocument);
router.delete('/admin/:id', authMiddleware, adminMiddleware, deleteDocument);

export default router;
