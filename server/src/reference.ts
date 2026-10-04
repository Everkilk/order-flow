import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireActor, requireRole, type Actor } from './auth.js';
import { withMutation } from './mutations.js';
import { AppError } from './errors.js';

const id = z.string().regex(/^[1-9]\d*$/);
const unitInput = z.object({ code:z.string().trim().min(1).max(30),name:z.string().trim().min(1).max(100),decimalPlaces:z.number().int().min(0).max(6) }).strict();
const warehouseInput = z.object({ code:z.string().trim().min(1).max(30),name:z.string().trim().min(1).max(160),address:z.string().max(500).nullable().optional() }).strict();
const supplierInput = z.object({ name:z.string().trim().min(1).max(160),email:z.email().nullable().optional(),phone:z.string().max(60).nullable().optional() }).strict();
const thresholdInput = z.object({ threshold:z.string().regex(/^\d+(?:\.\d{1,6})?$/),criticalThreshold:z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable().optional() }).strict();

export function referenceRoutes(pool: pg.Pool): Router {
  const router = Router();
  router.post('/units', requireRole('MANAGER'), async (req,res) => {
    const data = unitInput.parse(req.body), actor = res.locals.actor as Actor;
    const row = await withMutation(pool,req,actor,async c => {
      const result = await c.query('INSERT INTO orderflow.units(code,name,decimal_places) VALUES($1,$2,$3) RETURNING id::text,code,name,decimal_places AS "decimalPlaces"', [data.code,data.name,data.decimalPlaces]);
      await c.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'UNIT_CREATE','unit',$2)",[actor.id,result.rows[0].id]);
      return result.rows[0];
    });
    res.status(201).json(row);
  });
  router.post('/warehouses', requireRole('MANAGER'), async (req,res) => {
    const data = warehouseInput.parse(req.body), actor = res.locals.actor as Actor;
    const row = await withMutation(pool,req,actor,async c => {
      const result = await c.query('INSERT INTO orderflow.warehouses(code,name,address) VALUES($1,$2,$3) RETURNING id::text,code,name,address,active', [data.code,data.name,data.address ?? null]);
      await c.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'WAREHOUSE_CREATE','warehouse',$2)",[actor.id,result.rows[0].id]);
      return result.rows[0];
    });
    res.status(201).json(row);
  });
  router.get('/suppliers', requireActor, async (_req,res) => {
    const result = await pool.query('SELECT id::text,name,email,phone,active FROM orderflow.suppliers WHERE active ORDER BY name,id LIMIT 500');
    res.json({ items:result.rows });
  });
  router.post('/suppliers', requireRole('MANAGER'), async (req,res) => {
    const data = supplierInput.parse(req.body), actor = res.locals.actor as Actor;
    const row = await withMutation(pool,req,actor,async c => {
      const result = await c.query('INSERT INTO orderflow.suppliers(name,email,phone) VALUES($1,$2,$3) RETURNING id::text,name,email,phone,active', [data.name,data.email ?? null,data.phone ?? null]);
      await c.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'SUPPLIER_CREATE','supplier',$2)",[actor.id,result.rows[0].id]);
      return result.rows[0];
    });
    res.status(201).json(row);
  });
  router.put('/warehouses/:warehouseId/thresholds/:productId', requireRole('MANAGER'), async (req,res) => {
    const warehouseId=id.parse(req.params.warehouseId), productId=id.parse(req.params.productId);
    const data=thresholdInput.parse(req.body), actor=res.locals.actor as Actor;
    if (data.criticalThreshold != null && Number(data.criticalThreshold)>Number(data.threshold))
      throw new AppError(422,'INVALID_THRESHOLD','Critical threshold exceeds threshold.');
    await withMutation(pool,req,actor,async c => {
      await c.query(`INSERT INTO orderflow.low_stock_thresholds(warehouse_id,product_id,threshold,critical_threshold)
        VALUES($1,$2,$3,$4) ON CONFLICT(warehouse_id,product_id)
        DO UPDATE SET threshold=excluded.threshold,critical_threshold=excluded.critical_threshold`,
        [warehouseId,productId,data.threshold,data.criticalThreshold ?? null]);
      await c.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'THRESHOLD_SET','stock_balance',$2)",[actor.id,warehouseId+':'+productId]);
    });
    res.status(204).end();
  });
  return router;
}
