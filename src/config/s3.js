import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;

// Generate presigned URL for uploading (PUT)
export const generateUploadUrl = async (key, contentType = 'image/jpeg') => {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
  
  // Construct the public URL for viewing (without query params)
  const publicUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
  
  return { uploadUrl, publicUrl, key };
};

// Generate presigned URL for viewing (GET)
export const generateViewUrl = async (key, expiresIn = 3600) => {
  if (!key) return null;
  
  // Extract key from full URL if needed
  let objectKey = key;
  if (key.startsWith('http')) {
    const url = new URL(key);
    objectKey = decodeURIComponent(url.pathname.substring(1)); // Remove leading slash and decode
  }
  
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: objectKey,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

// Convert S3 URL to presigned view URL
export const getPresignedUrl = async (url, expiresIn = 3600) => {
  if (!url) return null;
  if (!url.includes('amazonaws.com')) return url; // Already presigned or external
  
  try {
    return await generateViewUrl(url, expiresIn);
  } catch (err) {
    console.error('Failed to generate presigned URL:', err);
    return url; // Fallback to original URL
  }
};

// Batch convert multiple URLs to presigned URLs
export const getPresignedUrls = async (urls, expiresIn = 3600) => {
  if (!urls || !Array.isArray(urls)) return [];
  
  const promises = urls.map(url => getPresignedUrl(url, expiresIn));
  return Promise.all(promises);
};

export const deleteObject = async (key) => {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  await s3Client.send(command);
};

// Extract S3 key from full URL
export const extractS3Key = (url) => {
  if (!url) return null;
  if (!url.includes('amazonaws.com')) return url;
  
  try {
    const urlObj = new URL(url);
    return decodeURIComponent(urlObj.pathname.substring(1)); // Remove leading slash and decode
  } catch {
    return url;
  }
};

export { s3Client, BUCKET_NAME };
