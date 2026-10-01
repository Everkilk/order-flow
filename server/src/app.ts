import express from 'express';
import helmet from 'helmet';
import type pg from 'pg';
import type { Config } from './config.js';
import { authMiddleware, authRoutes } from './auth.js';
import { AppError, errorHandler, notFound, requestId } from './errors.js';
import { catalogRoutes } from './catalog.js';
import { referenceRoutes } from './reference.js';
import { inventoryReadRoutes } from './inventory-read.js';
import { receiptRoutes } from './receipts.js';
import { orderRoutes } from './orders.js';
import { returnRoutes } from './returns.js';
import { transferRoutes } from './transfers.js';
import { discrepancyRoutes } from './discrepancies.js';
import { stockApprovalRoutes } from './stock-approvals.js';
import { notificationRoutes } from './notifications.js';
import { reportRoutes } from './reports.js';
import { jobRoutes } from './jobs.js';
import { dashboardRoutes } from './dashboard.js';
import { evidenceRoutes } from './evidence.js';

export function createApp(pool: pg.Pool, config: Config, shutdownSignal?: AbortSignal) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(requestId);
  app.use('/api',(_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
  app.use((req, _res, next) => {
    const mutating = !['GET','HEAD','OPTIONS'].includes(req.method);
    if (mutating && config.APP_ORIGIN && req.headers.origin !== config.APP_ORIGIN)
      return next(new AppError(403, 'INVALID_ORIGIN', 'Request origin is not allowed.'));
    next();
  });
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    const migration=await pool.query(`SELECT 1 FROM public.orderflow_schema_migrations
      WHERE filename='010_stock_availability.sql'`);
    if (!migration.rowCount) throw new AppError(503,'SCHEMA_NOT_READY','Database migrations are not current.');
    res.json({ status: 'ready' });
  });
  app.use('/api', authMiddleware(pool));
  app.use('/api', authRoutes(pool, config));
  app.use('/api', dashboardRoutes(pool));
  app.use('/api', catalogRoutes(pool));
  app.use('/api', referenceRoutes(pool));
  app.use('/api', inventoryReadRoutes(pool));
  app.use('/api', receiptRoutes(pool));
  app.use('/api', orderRoutes(pool));
  app.use('/api', returnRoutes(pool));
  app.use('/api', transferRoutes(pool));
  app.use('/api', discrepancyRoutes(pool));
  app.use('/api', stockApprovalRoutes(pool));
  app.use('/api', notificationRoutes(pool,shutdownSignal));
  app.use('/api', reportRoutes(pool));
  app.use('/api', jobRoutes(pool,config));
  app.use('/api', evidenceRoutes(pool,config));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
