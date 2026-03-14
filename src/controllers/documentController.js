import { db } from '../config/db.js';
import { generateUploadUrl, deleteObject, getPresignedUrl } from '../config/s3.js';
import { asyncHandler } from '../middleware/error.js';
import { normalizeResult, formatFileSize } from '../utils/helpers.js';

// ==================== FOLDERS ====================

// Get all folders (public)
export const getFolders = asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT f.*, COUNT(d.id) as document_count 
     FROM document_folders f
     LEFT JOIN documents d ON f.id = d.folder_id AND d.is_active = TRUE
     WHERE f.is_active = TRUE
     GROUP BY f.id
     ORDER BY f.sort_order ASC, f.name ASC`
  );
  const folders = normalizeResult(result);
  res.json({ folders });
});

// Get all folders (admin - includes inactive)
export const getAllFolders = asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT f.*, COUNT(d.id) as document_count 
     FROM document_folders f
     LEFT JOIN documents d ON f.id = d.folder_id
     GROUP BY f.id
     ORDER BY f.sort_order ASC, f.name ASC`
  );
  const folders = normalizeResult(result);
  res.json({ folders });
});

// Create folder
export const createFolder = asyncHandler(async (req, res) => {
  const { name, description, sort_order } = req.body;
  
  if (!name) {
    return res.status(400).json({ message: 'Folder name is required' });
  }
  
  const result = await db.query(
    'INSERT INTO document_folders (name, description, sort_order) VALUES (?, ?, ?)',
    [name, description || null, sort_order || 0]
  );
  
  res.status(201).json({
    message: 'Folder created successfully',
    folder: {
      id: result.insertId,
      name,
      description,
      sort_order: sort_order || 0
    }
  });
});

// Update folder
export const updateFolder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, description, sort_order, is_active } = req.body;
  
  const updates = [];
  const values = [];
  
  if (name !== undefined) {
    updates.push('name = ?');
    values.push(name);
  }
  if (description !== undefined) {
    updates.push('description = ?');
    values.push(description);
  }
  if (sort_order !== undefined) {
    updates.push('sort_order = ?');
    values.push(sort_order);
  }
  if (is_active !== undefined) {
    updates.push('is_active = ?');
    values.push(is_active);
  }
  
  if (updates.length === 0) {
    return res.status(400).json({ message: 'No fields to update' });
  }
  
  values.push(id);
  
  await db.query(
    `UPDATE document_folders SET ${updates.join(', ')} WHERE id = ?`,
    values
  );
  
  const result = await db.query('SELECT * FROM document_folders WHERE id = ?', [id]);
  const folders = normalizeResult(result);
  
  res.json({
    message: 'Folder updated successfully',
    folder: folders[0]
  });
});

// Delete folder (moves documents to uncategorized)
export const deleteFolder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  // Get or create uncategorized folder
  let uncategorizedResult = await db.query(
    "SELECT id FROM document_folders WHERE name = 'Uncategorized' LIMIT 1"
  );
  let uncategorizedFolders = normalizeResult(uncategorizedResult);
  
  let uncategorizedId;
  if (uncategorizedFolders.length === 0) {
    const createResult = await db.query(
      "INSERT INTO document_folders (name, description, sort_order) VALUES ('Uncategorized', 'Documents without a specific category', 99)"
    );
    uncategorizedId = createResult.insertId;
  } else {
    uncategorizedId = uncategorizedFolders[0].id;
  }
  
  // Move documents to uncategorized
  await db.query(
    'UPDATE documents SET folder_id = ? WHERE folder_id = ?',
    [uncategorizedId, id]
  );
  
  // Delete the folder
  await db.query('DELETE FROM document_folders WHERE id = ?', [id]);
  
  res.json({ message: 'Folder deleted successfully' });
});

// ==================== DOCUMENTS ====================

// Get documents (public - only active)
export const getDocuments = asyncHandler(async (req, res) => {
  const { folder_id, search } = req.query;
  
  let sql = `
    SELECT d.*, f.name as folder_name
    FROM documents d
    LEFT JOIN document_folders f ON d.folder_id = f.id
    WHERE d.is_active = TRUE AND (f.is_active = TRUE OR f.id IS NULL)
  `;
  const params = [];
  
  if (folder_id) {
    sql += ' AND d.folder_id = ?';
    params.push(folder_id);
  }
  
  if (search) {
    sql += ' AND (d.title LIKE ? OR d.description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  
  sql += ' ORDER BY d.created_at DESC';
  
  const result = await db.query(sql, params);
  const documents = normalizeResult(result);
  
  // Format file sizes
  const formattedDocs = documents.map(doc => ({
    ...doc,
    file_size_formatted: formatFileSize(doc.file_size)
  }));
  
  res.json({ documents: formattedDocs });
});

// Get all documents (admin)
export const getAllDocuments = asyncHandler(async (req, res) => {
  const { folder_id, search, is_active } = req.query;
  
  let sql = `
    SELECT d.*, f.name as folder_name, u.email as uploaded_by
    FROM documents d
    LEFT JOIN document_folders f ON d.folder_id = f.id
    LEFT JOIN users u ON d.created_by = u.id
    WHERE 1=1
  `;
  const params = [];
  
  if (folder_id) {
    sql += ' AND d.folder_id = ?';
    params.push(folder_id);
  }
  
  if (is_active !== undefined) {
    sql += ' AND d.is_active = ?';
    params.push(is_active === 'true' ? 1 : 0);
  }
  
  if (search) {
    sql += ' AND (d.title LIKE ? OR d.description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  
  sql += ' ORDER BY d.created_at DESC';
  
  const result = await db.query(sql, params);
  const documents = normalizeResult(result);
  
  // Format file sizes
  const formattedDocs = documents.map(doc => ({
    ...doc,
    file_size_formatted: formatFileSize(doc.file_size)
  }));
  
  res.json({ documents: formattedDocs });
});

// Get single document
export const getDocument = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const result = await db.query(
    `SELECT d.*, f.name as folder_name, u.email as uploaded_by
     FROM documents d
     LEFT JOIN document_folders f ON d.folder_id = f.id
     LEFT JOIN users u ON d.created_by = u.id
     WHERE d.id = ?`,
    [id]
  );
  const documents = normalizeResult(result);
  
  if (documents.length === 0) {
    return res.status(404).json({ message: 'Document not found' });
  }
  
  const document = documents[0];
  document.file_size_formatted = formatFileSize(document.file_size);
  
  // Generate presigned URL for viewing
  document.view_url = await getPresignedUrl(document.file_url, 3600);
  
  res.json({ document });
});

// Get presigned URL for PDF upload
export const getUploadUrl = asyncHandler(async (req, res) => {
  const { filename, folder_name } = req.body;
  
  if (!filename) {
    return res.status(400).json({ message: 'Filename is required' });
  }
  
  // Sanitize filename
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  const folderPath = folder_name ? folder_name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() : 'uncategorized';
  const key = `pdf/${folderPath}/${Date.now()}-${sanitizedFilename}`;
  
  const { uploadUrl, publicUrl } = await generateUploadUrl(key, 'application/pdf');
  const viewUrl = await getPresignedUrl(publicUrl, 3600);
  
  res.json({
    uploadUrl,
    publicUrl,
    viewUrl,
    key
  });
});

// Create document record after upload
export const createDocument = asyncHandler(async (req, res) => {
  const { title, description, folder_id, file_name, file_url, file_size } = req.body;
  const userId = req.user.userId;
  
  if (!title || !file_url) {
    return res.status(400).json({ message: 'Title and file URL are required' });
  }
  
  const result = await db.query(
    `INSERT INTO documents 
     (folder_id, title, description, file_name, file_url, file_size, mime_type, created_by) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      folder_id || null,
      title,
      description || null,
      file_name || title,
      file_url,
      file_size || 0,
      'application/pdf',
      userId
    ]
  );
  
  res.status(201).json({
    message: 'Document created successfully',
    document: {
      id: result.insertId,
      title,
      description,
      folder_id,
      file_name,
      file_url,
      file_size,
      file_size_formatted: formatFileSize(file_size || 0)
    }
  });
});

// Update document
export const updateDocument = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, description, folder_id, is_active } = req.body;
  
  const updates = [];
  const values = [];
  
  if (title !== undefined) {
    updates.push('title = ?');
    values.push(title);
  }
  if (description !== undefined) {
    updates.push('description = ?');
    values.push(description);
  }
  if (folder_id !== undefined) {
    updates.push('folder_id = ?');
    values.push(folder_id);
  }
  if (is_active !== undefined) {
    updates.push('is_active = ?');
    values.push(is_active);
  }
  
  if (updates.length === 0) {
    return res.status(400).json({ message: 'No fields to update' });
  }
  
  values.push(id);
  
  await db.query(
    `UPDATE documents SET ${updates.join(', ')} WHERE id = ?`,
    values
  );
  
  const result = await db.query(
    `SELECT d.*, f.name as folder_name
     FROM documents d
     LEFT JOIN document_folders f ON d.folder_id = f.id
     WHERE d.id = ?`,
    [id]
  );
  const documents = normalizeResult(result);
  
  if (documents.length === 0) {
    return res.status(404).json({ message: 'Document not found' });
  }
  
  const document = documents[0];
  document.file_size_formatted = formatFileSize(document.file_size);
  
  res.json({
    message: 'Document updated successfully',
    document
  });
});

// Delete document
export const deleteDocument = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  // Get document to find S3 key
  const result = await db.query('SELECT file_url FROM documents WHERE id = ?', [id]);
  const documents = normalizeResult(result);
  
  if (documents.length === 0) {
    return res.status(404).json({ message: 'Document not found' });
  }
  
  // Extract S3 key and delete from S3
  const fileUrl = documents[0].file_url;
  if (fileUrl && fileUrl.includes('amazonaws.com')) {
    try {
      // Extract key from URL
      const urlObj = new URL(fileUrl);
      const key = decodeURIComponent(urlObj.pathname.substring(1));
      await deleteObject(key);
    } catch (err) {
      console.error('Failed to delete from S3:', err);
      // Continue with database deletion even if S3 fails
    }
  }
  
  // Delete from database
  await db.query('DELETE FROM documents WHERE id = ?', [id]);
  
  res.json({ message: 'Document deleted successfully' });
});

// Increment download count
export const incrementDownloadCount = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  await db.query(
    'UPDATE documents SET download_count = download_count + 1 WHERE id = ?',
    [id]
  );
  
  res.json({ message: 'Download count updated' });
});
