import { db } from '../config/db.js';
import { generateUploadUrl, deleteObject, getPresignedUrl, extractS3Key } from '../config/s3.js';
import { asyncHandler } from '../middleware/error.js';

// Helper to generate order number
const generateOrderNumber = () => {
  return 'ORD-' + Date.now().toString(36).toUpperCase();
};

// Helper to normalize query results to array
const normalizeResult = (result) => {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    if (result.id !== undefined || result.name !== undefined || result.image_url !== undefined) {
      return [result];
    }
  }
  return [];
};

// Helper to convert product images to presigned URLs
const convertProductImagesToPresigned = async (product) => {
  if (!product) return product;
  
  return {
    ...product,
    image_url: await getPresignedUrl(product.image_url, 3600),
  };
};

// Helper to convert multiple products' images
const convertProductsImagesToPresigned = async (products) => {
  return Promise.all(products.map(convertProductImagesToPresigned));
};

// ==================== PRODUCTS ====================

// Get all products with optional filters
export const getProducts = asyncHandler(async (req, res) => {
  const { category, status, search } = req.query;
  
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  
  if (category && category !== 'All') {
    sql += ' AND category = ?';
    params.push(category);
  }
  
  if (status && status !== 'all') {
    sql += ' AND status = ?';
    params.push(status);
  }
  
  if (search) {
    sql += ' AND (name LIKE ? OR description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  
  sql += ' ORDER BY created_at DESC';
  
  const result = await db.query(sql, params);
  const products = normalizeResult(result);
  
  // Fetch primary image for each product and convert to presigned URL
  const productsWithImages = await Promise.all(
    products.map(async (product) => {
      const imgResult = await db.query(
        'SELECT image_url FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, sort_order ASC LIMIT 1',
        [product.id]
      );
      const images = normalizeResult(imgResult);
      const imageUrl = images.length > 0 ? images[0].image_url : product.image_url;
      
      return {
        ...product,
        image_url: await getPresignedUrl(imageUrl, 3600)
      };
    })
  );
  
  res.json({ products: productsWithImages });
});

// Get single product with all images
export const getProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await db.query('SELECT * FROM products WHERE id = ?', [id]);
  const products = normalizeResult(result);
  
  if (products.length === 0) {
    return res.status(404).json({ message: 'Product not found' });
  }
  
  const product = products[0];
  
  // Fetch all images from product_images table
  const imgResult = await db.query(
    'SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, sort_order ASC',
    [id]
  );
  let images = normalizeResult(imgResult);
  
  // If no images in product_images table but product has image_url, create a fallback image entry
  if (images.length === 0 && product.image_url) {
    images = [{
      id: null,
      product_id: product.id,
      image_url: product.image_url,
      is_primary: 1,
      sort_order: 0,
      created_at: product.created_at
    }];
  }
  
  // Convert all image URLs to presigned URLs
  const imagesWithPresignedUrls = await Promise.all(
    images.map(async (img) => ({
      ...img,
      image_url: await getPresignedUrl(img.image_url, 3600)
    }))
  );
  
  // Convert product main image_url to presigned URL
  product.image_url = await getPresignedUrl(product.image_url, 3600);
  
  res.json({ 
    product,
    images: imagesWithPresignedUrls
  });
});

// Create product with images
export const createProduct = asyncHandler(async (req, res) => {
  const { name, description, price, category, image_url, images, stock_quantity, status } = req.body;
  
  if (!name || !price || !category) {
    return res.status(400).json({ message: 'Name, price, and category are required' });
  }
  
  // Filter out null/empty image URLs
  const validImages = images ? images.filter(img => img && typeof img === 'string' && img.trim() !== '') : [];
  
  if (validImages.length === 0) {
    return res.status(400).json({ message: 'At least one valid image is required' });
  }
  
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Insert product
    const productResult = await connection.query(
      `INSERT INTO products (name, description, price, category, image_url, stock_quantity, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, description || '', price, category, validImages[0], stock_quantity || 0, status || 'active']
    );
    
    const productId = productResult.insertId;
    
    if (!productId) {
      throw new Error('Failed to get product ID after insert');
    }
    
    // Insert all valid images
    for (let i = 0; i < validImages.length; i++) {
      await connection.query(
        'INSERT INTO product_images (product_id, image_url, is_primary, sort_order) VALUES (?, ?, ?, ?)',
        [productId, validImages[i], i === 0 ? 1 : 0, i]
      );
    }
    
    await connection.commit();
    
    const productResult2 = await db.query('SELECT * FROM products WHERE id = ?', [productId]);
    const product = normalizeResult(productResult2);
    
    res.status(201).json({ 
      message: 'Product created successfully',
      product: product[0]
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating product:', error);
    throw error;
  } finally {
    connection.release();
  }
});

// Update product
export const updateProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, description, price, category, image_url, images, stock_quantity, status } = req.body;
  
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Update product
    await connection.query(
      `UPDATE products SET 
        name = ?, 
        description = ?, 
        price = ?, 
        category = ?, 
        image_url = ?,
        stock_quantity = ?, 
        status = ? 
      WHERE id = ?`,
      [name, description || '', price, category, images && images.length > 0 ? images[0] : image_url, 
       stock_quantity || 0, status || 'active', id]
    );
    
    // If new images provided, update product_images
    if (images && images.length > 0) {
      // Filter out null/empty image URLs
      const validImages = images.filter(img => img && typeof img === 'string' && img.trim() !== '');
      
      if (validImages.length > 0) {
        // Delete old images
        await connection.query('DELETE FROM product_images WHERE product_id = ?', [id]);
        
        // Insert new images
        for (let i = 0; i < validImages.length; i++) {
          await connection.query(
            'INSERT INTO product_images (product_id, image_url, is_primary, sort_order) VALUES (?, ?, ?, ?)',
            [id, validImages[i], i === 0 ? 1 : 0, i]
          );
        }
      }
    }
    
    await connection.commit();
    
    const result = await db.query('SELECT * FROM products WHERE id = ?', [id]);
    const product = normalizeResult(result);
    
    res.json({ 
      message: 'Product updated successfully',
      product: product[0]
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating product:', error);
    throw error;
  } finally {
    connection.release();
  }
});

// Delete product and its images from S3
export const deleteProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  // Get product to check for legacy image_url
  const productResult = await db.query('SELECT image_url FROM products WHERE id = ?', [id]);
  const products = normalizeResult(productResult);
  const product = products[0];
  
  // Get all images for this product
  const imgResult = await db.query(
    'SELECT image_url FROM product_images WHERE product_id = ?',
    [id]
  );
  const images = normalizeResult(imgResult);
  
  // Collect all unique S3 keys to delete
  const keysToDelete = new Set();
  
  // Add product_images URLs
  for (const image of images) {
    const key = extractS3Key(image.image_url);
    if (key) keysToDelete.add(key);
  }
  
  // Add legacy product image_url if different from product_images
  if (product?.image_url) {
    const productKey = extractS3Key(product.image_url);
    if (productKey) keysToDelete.add(productKey);
  }
  
  // Delete all images from S3
  for (const key of keysToDelete) {
    try {
      await deleteObject(key);
      console.log(`Deleted from S3: ${key}`);
    } catch (err) {
      console.error(`Failed to delete from S3: ${key}`, err.message);
      // Continue deleting other images even if one fails
    }
  }
  
  // Delete product (product_images will be deleted via CASCADE)
  await db.query('DELETE FROM products WHERE id = ?', [id]);
  
  res.json({ 
    message: 'Product and images deleted successfully',
    deletedImages: keysToDelete.size
  });
});

// Get presigned URL for image upload
export const getUploadUrl = asyncHandler(async (req, res) => {
  const { filename, contentType } = req.body;
  
  if (!filename) {
    return res.status(400).json({ message: 'Filename is required' });
  }
  
  const key = `products/${Date.now()}-${filename}`;
  const { uploadUrl, publicUrl } = await generateUploadUrl(key, contentType);
  
  res.json({ 
    uploadUrl, 
    publicUrl,
    key 
  });
});

// Get all categories
export const getCategories = asyncHandler(async (req, res) => {
  const result = await db.query(
    'SELECT DISTINCT category FROM products ORDER BY category'
  );
  const categories = normalizeResult(result);
  
  res.json({ categories: categories.map(c => c.category) });
});

// ==================== ORDERS ====================

// Get all orders (admin)
export const getOrders = asyncHandler(async (req, res) => {
  const { status, search } = req.query;
  
  let sql = `
    SELECT o.*, u.email as customer_email, COUNT(oi.id) as item_count
    FROM orders o
    JOIN users u ON o.user_id = u.id
    LEFT JOIN order_items oi ON o.id = oi.order_id
    WHERE 1=1
  `;
  const params = [];
  
  if (status && status !== 'All') {
    sql += ' AND o.status = ?';
    params.push(status);
  }
  
  if (search) {
    sql += ' AND (o.order_number LIKE ? OR u.email LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  
  sql += ' GROUP BY o.id ORDER BY o.created_at DESC';
  
  const result = await db.query(sql, params);
  const orders = normalizeResult(result);
  
  res.json({ orders });
});

// Get single order
export const getOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const orderResult = await db.query(
    `SELECT o.*, u.email as customer_email
     FROM orders o
     JOIN users u ON o.user_id = u.id
     WHERE o.id = ?`,
    [id]
  );
  const orders = normalizeResult(orderResult);
  
  if (orders.length === 0) {
    return res.status(404).json({ message: 'Order not found' });
  }
  
  const itemResult = await db.query(
    `SELECT oi.*, p.name, p.image_url
     FROM order_items oi
     JOIN products p ON oi.product_id = p.id
     WHERE oi.order_id = ?`,
    [id]
  );
  const items = normalizeResult(itemResult);
  
  res.json({ 
    order: orders[0],
    items
  });
});

// Update order status
export const updateOrderStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  await db.query(
    'UPDATE orders SET status = ? WHERE id = ?',
    [status, id]
  );
  
  const result = await db.query('SELECT * FROM orders WHERE id = ?', [id]);
  const order = normalizeResult(result);
  
  res.json({ 
    message: 'Order status updated',
    order: order[0]
  });
});

// ==================== DASHBOARD ====================

// Get dashboard stats
export const getDashboardStats = asyncHandler(async (req, res) => {
  // Total products
  const productsResult = await db.query('SELECT COUNT(*) as count FROM products');
  
  // Total orders
  const ordersResult = await db.query('SELECT COUNT(*) as count FROM orders');
  
  // Total revenue
  const revenueResult = await db.query(
    "SELECT SUM(total_amount) as total FROM orders WHERE status != 'cancelled'"
  );
  
  // Total customers (non-admin users)
  const customersResult = await db.query(
    "SELECT COUNT(*) as count FROM users WHERE is_admin = 0 OR is_admin = false"
  );
  
  // Recent orders
  const recentOrdersResult = await db.query(
    `SELECT o.*, u.email as customer_email
     FROM orders o
     JOIN users u ON o.user_id = u.id
     ORDER BY o.created_at DESC
     LIMIT 5`
  );
  
  // Orders by status
  const ordersByStatusResult = await db.query(
    `SELECT status, COUNT(*) as count
     FROM orders
     GROUP BY status`
  );
  
  // Handle array or object result from db.query
  const getCount = (result) => {
    if (Array.isArray(result) && result.length > 0) return result[0].count;
    if (result && typeof result === 'object') return result.count;
    return 0;
  };
  
  const getTotal = (result) => {
    if (Array.isArray(result) && result.length > 0) return result[0].total;
    if (result && typeof result === 'object') return result.total;
    return 0;
  };
  
  const recentOrders = normalizeResult(recentOrdersResult);
  const ordersByStatus = normalizeResult(ordersByStatusResult);
  
  res.json({
    stats: {
      totalProducts: getCount(productsResult),
      totalOrders: getCount(ordersResult),
      totalRevenue: getTotal(revenueResult) || 0,
      totalCustomers: getCount(customersResult),
    },
    recentOrders,
    ordersByStatus
  });
});
