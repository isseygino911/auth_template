const cron = require('node-cron');
const inventoryService = require('../services/inventoryService.js');
const db = require('../config/db.js');

// Store job references for cleanup
const jobs = {
  cleanupExpiredReservations: null,
  lowStockAlert: null,
  generateInventoryReport: null,
};

/**
 * Cleanup expired reservations job
 * Runs every 5 minutes
 */
function cleanupExpiredReservationsJob() {
  return cron.schedule('*/5 * * * *', async () => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Running cleanupExpiredReservationsJob...`);

    try {
      const result = await inventoryService.cleanupExpiredReservations();
      console.log(`[${timestamp}] cleanupExpiredReservationsJob completed:`, result);
    } catch (error) {
      console.error(`[${timestamp}] cleanupExpiredReservationsJob failed:`, error.message);
      // Don't throw - job should continue running despite errors
    }
  });
}

/**
 * Low stock alert job
 * Runs daily at 9 AM
 * Checks all products against alert thresholds
 */
function lowStockAlertJob() {
  return cron.schedule('0 9 * * *', async () => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Running lowStockAlertJob...`);

    try {
      // Get all products with their inventory and alert thresholds
      const query = `
        SELECT 
          p.id,
          p.name,
          p.sku,
          i.quantity,
          i.alert_threshold
        FROM products p
        JOIN inventory i ON p.id = i.product_id
        WHERE i.alert_threshold > 0
      `;
      const { rows: products } = await db.query(query);

      // Filter products below threshold
      const lowStockProducts = products.filter(
        (product) => product.quantity <= product.alert_threshold
      );

      if (lowStockProducts.length === 0) {
        console.log(`[${timestamp}] lowStockAlertJob: No products below threshold`);
        return;
      }

      // Log low stock products (email sending can be added later)
      console.log(`[${timestamp}] lowStockAlertJob: Found ${lowStockProducts.length} products below threshold:`);
      for (const product of lowStockProducts) {
        console.log(
          `  - ${product.name} (SKU: ${product.sku}): Quantity ${product.quantity}, Threshold: ${product.alert_threshold}`
        );
      }

      // TODO: Add email notification logic here when ready
      // Example: await emailService.sendLowStockAlert(lowStockProducts);
    } catch (error) {
      console.error(`[${timestamp}] lowStockAlertJob failed:`, error.message);
      // Don't throw - job should continue running despite errors
    }
  });
}

/**
 * Generate inventory report job
 * Runs weekly on Sunday at midnight
 * Placeholder for report generation
 */
function generateInventoryReportJob() {
  return cron.schedule('0 0 * * 0', async () => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Running generateInventoryReportJob...`);

    try {
      // Placeholder for report generation logic
      console.log(`[${timestamp}] generateInventoryReportJob: Report generation placeholder executed`);

      // TODO: Implement actual report generation when ready
      // Example:
      // const reportData = await inventoryService.generateWeeklyReport();
      // await reportService.saveReport(reportData);
      // await emailService.sendWeeklyReport(reportData);
    } catch (error) {
      console.error(`[${timestamp}] generateInventoryReportJob failed:`, error.message);
      // Don't throw - job should continue running despite errors
    }
  });
}

/**
 * Start all inventory-related cron jobs
 * @returns {Object} Job references for cleanup
 */
function startInventoryJobs() {
  console.log('Starting inventory cron jobs...');

  // Prevent duplicate job starts
  if (jobs.cleanupExpiredReservations || jobs.lowStockAlert || jobs.generateInventoryReport) {
    console.log('Inventory jobs already running, skipping start');
    return jobs;
  }

  // Schedule all jobs
  jobs.cleanupExpiredReservations = cleanupExpiredReservationsJob();
  jobs.lowStockAlert = lowStockAlertJob();
  jobs.generateInventoryReport = generateInventoryReportJob();

  console.log('Inventory cron jobs started successfully');
  console.log('  - cleanupExpiredReservations: every 5 minutes');
  console.log('  - lowStockAlert: daily at 9:00 AM');
  console.log('  - generateInventoryReport: weekly on Sunday at midnight');

  return jobs;
}

/**
 * Stop all scheduled inventory jobs
 * For graceful shutdown
 */
function stopInventoryJobs() {
  console.log('Stopping inventory cron jobs...');

  const jobNames = Object.keys(jobs);
  let stoppedCount = 0;

  for (const jobName of jobNames) {
    const job = jobs[jobName];
    if (job && typeof job.stop === 'function') {
      job.stop();
      jobs[jobName] = null;
      stoppedCount++;
      console.log(`  - ${jobName} stopped`);
    }
  }

  console.log(`Stopped ${stoppedCount} inventory cron jobs`);
}

module.exports = {
  startInventoryJobs,
  stopInventoryJobs,
};
