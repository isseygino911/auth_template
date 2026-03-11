import express from 'express';
import { db } from '../config/db.js';
import { getPresignedUrl } from '../config/s3.js';
import { asyncHandler } from '../middleware/error.js';

const router = express.Router();

// Helper to normalize query results to array
const normalizeResult = (result) => {
  if (Array.isArray(result)) return result;
  // If it's a single object (like from a SELECT), wrap in array
  if (result && typeof result === 'object') {
    // Check if it has row-like properties
    if (result.id !== undefined || result.name !== undefined || result.image_url !== undefined) {
      return [result];
    }
  }
  return [];
};

// Helper to convert product image to presigned URL
const convertProductImage = async (product) => {
  if (!product) return product;
  return {
    ...product,
    image_url: await getPresignedUrl(product.image_url, 3600)
  };
};

// Helper to fetch products with their primary image (as presigned URL)
const fetchProductsWithImages = async (sql, params) => {
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
  
  return productsWithImages;
};

// Get all products (public - for storefront)
router.get('/', asyncHandler(async (req, res) => {
  const { category, search } = req.query;
  
  let sql = `
    SELECT id, uuid, name, description, price, category, image_url, stock_quantity, status
    FROM products 
    WHERE status = 'active'
  `;
  const params = [];
  
  if (category && category !== 'All') {
    sql += ' AND category = ?';
    params.push(category);
  }
  
  if (search) {
    sql += ' AND (name LIKE ? OR description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  
  sql += ' ORDER BY created_at DESC';
  
  const products = await fetchProductsWithImages(sql, params);
  res.json({ products });
}));

// Get featured products (for homepage)
router.get('/featured', asyncHandler(async (req, res) => {
  const sql = `
    SELECT id, uuid, name, description, price, category, image_url
    FROM products 
    WHERE status = 'active'
    ORDER BY created_at DESC
    LIMIT 8
  `;
  const products = await fetchProductsWithImages(sql, []);
  res.json({ products });
}));

// Get all categories (public)
router.get('/categories', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT DISTINCT category 
     FROM products 
     WHERE status = 'active'
     ORDER BY category`
  );
  const categories = normalizeResult(result);
  res.json({ categories: categories.map(c => c.category) });
}));

// Get single product (public) - accepts UUID or numeric ID
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  // Check if id is a UUID format (contains hyphens and is 36 chars)
  const isUUID = id.includes('-') && id.length === 36;
  
  const result = await db.query(
    `SELECT id, uuid, name, description, price, category, image_url, stock_quantity, status, created_at
     FROM products 
     WHERE ${isUUID ? 'uuid' : 'id'} = ? AND status = 'active'`,
    [id]
  );
  
  const products = normalizeResult(result);
  
  if (products.length === 0) {
    return res.status(404).json({ message: 'Product not found' });
  }
  
  const product = products[0];
  
  // Fetch all images for this product
  const imgResult = await db.query(
    `SELECT id, image_url, is_primary, sort_order FROM product_images 
     WHERE product_id = ? 
     ORDER BY is_primary DESC, sort_order ASC`,
    [product.id]
  );
  let images = normalizeResult(imgResult);
  
  // If no images in product_images but product has image_url, create fallback
  if (images.length === 0 && product.image_url) {
    images = [{
      id: null,
      image_url: product.image_url,
      is_primary: 1,
      sort_order: 0
    }];
  } else if (images.length > 0) {
    // Use primary image from product_images as the main image_url
    product.image_url = images[0].image_url;
  }
  
  // Convert all image URLs to presigned URLs
  const imagesWithPresigned = await Promise.all(
    images.map(async (img) => ({
      ...img,
      image_url: await getPresignedUrl(img.image_url, 3600)
    }))
  );
  
  // Convert product main image to presigned URL
  product.image_url = await getPresignedUrl(product.image_url, 3600);
  
  res.json({ product, images: imagesWithPresigned });
}));

// Get product images
router.get('/:id/images', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await db.query(
    `SELECT id, image_url, is_primary, sort_order 
     FROM product_images 
     WHERE product_id = ? 
     ORDER BY is_primary DESC, sort_order ASC`,
    [id]
  );
  const images = normalizeResult(result);
  res.json({ images });
}));

export default router;
