// Shared utility functions for backend controllers

/**
 * Normalizes database query results to an array.
 * Handles cases where the result might be:
 * - An array (return as-is)
 * - A single object with id/name/image_url (wrap in array)
 * - Null/undefined (return empty array)
 * @param {any} result - Database query result
 * @returns {Array} - Normalized array
 */
export const normalizeResult = (result) => {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    // Check if it has row-like properties
    if (result.id !== undefined || result.name !== undefined || result.image_url !== undefined) {
      return [result];
    }
  }
  return [];
};

/**
 * Generates a random order number
 * @returns {string} - Order number like 'ORD-ABC123XYZ'
 */
export const generateOrderNumber = () => {
  return 'ORD-' + Date.now().toString(36).toUpperCase();
};

/**
 * Formats file size in human-readable format
 * @param {number} bytes - File size in bytes
 * @returns {string} - Formatted string like '2.4 MB'
 */
export const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};
