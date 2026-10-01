import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireActor, requireRole, warehouseAllowed, type Actor } from './auth.js';
import { AppError } from './errors.js';

const id=z.string().regex(/^[1-9]\d*$/);
const lowFilters=z.object({warehouseId:id.optional(),cursor:z.string().regex(/^[1-9]\d*:[1-9]\d*$/).optional(),
  limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
const summaryFilters=z.object({warehouseId:id,from:z.iso.datetime({offset:true}),to:z.iso.datetime({offset:true})}).strict();
const valuationFilters=z.object({warehouseId:id.optional()}).strict();

export async function getValuation(pool:pg.Pool,warehouseId?:string) {
  const result=await pool.query(`SELECT ps.currency,count(*)::text AS "stockRows",
    coalesce(sum(b.on_hand*ps.cost),0)::text AS amount
    FROM orderflow.inventory_balances b
    LEFT JOIN orderflow.product_suppliers ps ON ps.product_id=b.product_id AND ps.primary_supplier
    WHERE b.on_hand>0 AND ($1::bigint IS NULL OR b.warehouse_id=$1)
    GROUP BY ps.currency ORDER BY ps.currency`,[warehouseId ?? null]);
  return {
    currencyTotals:result.rows.filter(row=>row.currency!==null).map(row=>({
      currency:row.currency,amount:row.amount,stockRows:row.stockRows,
    })),
    unvaluedStockRows:result.rows.find(row=>row.currency===null)?.stockRows ?? '0',
    method:'PRIMARY_SUPPLIER_COST' as const,
  };
}

export function reportRoutes(pool: pg.Pool): Router {
  const router=Router();
  router.get('/reports/valuation',requireRole('MANAGER'),async(req,res) => {
    const input=valuationFilters.parse(req.query);
    if (input.warehouseId) {
      const found=await pool.query('SELECT 1 FROM orderflow.warehouses WHERE id=$1',[input.warehouseId]);
      if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Warehouse not found.');
    }
    res.json({warehouseId:input.warehouseId ?? null,...await getValuation(pool,input.warehouseId)});
  });
  router.get('/reports/low-stock',requireActor,async(req,res) => {
    const input=lowFilters.parse(req.query),actor=res.locals.actor as Actor;
    if (input.warehouseId && !warehouseAllowed(actor,input.warehouseId))
      throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
    const [cursorWarehouse,cursorProduct]=input.cursor?.split(':') ?? [null,null];
    const result=await pool.query(`SELECT t.warehouse_id::text AS "warehouseId",w.code AS warehouse,
      t.product_id::text AS "productId",p.sku,p.name,b.available::text AS available,
      t.threshold::text,t.critical_threshold::text AS "criticalThreshold"
      FROM orderflow.low_stock_thresholds t
      JOIN orderflow.inventory_balances b USING(warehouse_id,product_id)
      JOIN orderflow.products p ON p.id=t.product_id JOIN orderflow.warehouses w ON w.id=t.warehouse_id
      WHERE b.available<=t.threshold AND ($1::bigint IS NULL OR t.warehouse_id=$1)
      AND ($2 OR t.warehouse_id=ANY($3::bigint[]))
      AND ($4::bigint IS NULL OR (t.warehouse_id,t.product_id)>($4::bigint,$5::bigint))
      ORDER BY t.warehouse_id,t.product_id LIMIT $6`,
      [input.warehouseId ?? null,actor.role==='MANAGER',actor.warehouses,cursorWarehouse,cursorProduct,input.limit+1]);
    const rows=result.rows.slice(0,input.limit);
    const last=rows.at(-1);
    res.json({items:rows,nextCursor:result.rows.length>input.limit && last ? `${last.warehouseId}:${last.productId}` : null});
  });
  router.get('/reports/movements',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=summaryFilters.parse(req.query),actor=res.locals.actor as Actor;
    if (!warehouseAllowed(actor,input.warehouseId)) throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
    const from=new Date(input.from),to=new Date(input.to);
    if (to<=from || to.getTime()-from.getTime()>31*24*60*60*1000)
      throw new AppError(400,'INVALID_RANGE','Choose a range of at most 31 days.');
    const result=await pool.query(`SELECT (l.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS day,
      e.event_type AS "eventType",count(*)::integer AS movements,
      sum(l.on_hand_delta)::text AS "onHandDelta",sum(l.reserved_delta)::text AS "reservedDelta"
      FROM orderflow.inventory_ledger l JOIN orderflow.inventory_events e ON e.id=l.event_id
      WHERE l.warehouse_id=$1 AND l.created_at>=$2 AND l.created_at<$3
      GROUP BY day,e.event_type ORDER BY day,e.event_type`,
      [input.warehouseId,input.from,input.to]);
    res.json({items:result.rows,from:input.from,to:input.to});
  });
  return router;
}
