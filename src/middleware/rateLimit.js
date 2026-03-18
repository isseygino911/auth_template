import rateLimit from 'express-rate-limit';

/**
 * Auth rate limiter - for login/register endpoints
 * Limits authentication attempts to prevent brute force attacks
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: {
    message: 'Too many attempts. Try again in 15 minutes.'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Skip successful requests (don't count them against limit)
  skipSuccessfulRequests: true,
  // Custom key generator to limit by IP address
  keyGenerator: (req) => {
    return req.ip || req.connection.remoteAddress;
  }
});

/**
 * General API rate limiter
 * Limits general API requests to prevent abuse
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: {
    message: 'Too many requests, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip for authenticated users (optional, good for UX)
  skip: (req) => {
    return req.user != null;
  },
  keyGenerator: (req) => {
    return req.ip || req.connection.remoteAddress;
  }
});
