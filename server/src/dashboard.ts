import { Router } from 'express';
import type pg from 'pg';
import { requireActor, type Actor } from './auth.js';
import { getValuation } from './reports.js';

export function dashboardRoutes(pool:pg.Pool):Router {
  const router=Router();
  router.get('/dashboard',requireActor,async(_req,res) => {
    const actor=res.locals.actor as Actor;
    const [stock,unread]=await Promise.all([
      pool.query(`SELECT count(*)::text AS "stockRows",
        count(*) FILTER (WHERE b.available=0)::text AS "outOfStock",
        count(*) FILTER (WHERE t.threshold IS NOT NULL AND b.available<=t.threshold)::text AS "lowStock"
        FROM orderflow.inventory_balances b
        LEFT JOIN orderflow.low_stock_thresholds t USING(warehouse_id,product_id)
        WHERE $1 OR b.warehouse_id=ANY($2::bigint[])`,
      [actor.role==='MANAGER',actor.warehouses]),
      pool.query('SELECT count(*)::text AS count FROM orderflow.notifications WHERE user_id=$1 AND read_at IS NULL',
        [actor.id]),
    ]);
    const common={generatedAt:new Date().toISOString(),role:actor.role,
      stock:stock.rows[0],unreadNotifications:unread.rows[0].count};
    if (actor.role==='VIEWER') return res.json(common);
    const [orders,transfers,requests,valuation]=await Promise.all([
      pool.query(`SELECT
        count(*) FILTER (WHERE o.status='DRAFT')::text AS drafts,
        count(*) FILTER (WHERE o.status='CONFIRMED')::text AS "awaitingFulfillment"
        FROM orderflow.orders o
        WHERE o.status IN ('DRAFT','CONFIRMED')
          AND ($1 OR o.created_by=$2 OR o.assigned_to=$2)
          AND ($1 OR NOT EXISTS(SELECT 1 FROM orderflow.order_items oi
            WHERE oi.order_id=o.id AND oi.warehouse_id<>ALL($3::bigint[])))`,
      [actor.role==='MANAGER',actor.id,actor.warehouses]),
      pool.query(`SELECT
        count(*) FILTER (WHERE t.status IN ('SENT','PARTIALLY_RECEIVED','DISPUTED')
          AND ($1 OR t.destination_warehouse_id=ANY($2::bigint[])))::text AS "awaitingReceipt",
        count(*) FILTER (WHERE t.status='DISPUTED'
          AND ($1 OR t.source_warehouse_id=ANY($2::bigint[]) OR t.destination_warehouse_id=ANY($2::bigint[])))::text AS disputed
        FROM orderflow.transfers t WHERE t.status IN ('SENT','PARTIALLY_RECEIVED','DISPUTED')`,
      [actor.role==='MANAGER',actor.warehouses]),
      pool.query(`SELECT count(*)::text AS count FROM orderflow.stock_change_requests r
        WHERE NOT EXISTS(SELECT 1 FROM orderflow.stock_change_decisions d WHERE d.request_id=r.id)
          AND ($1 OR (r.requested_by=$2 AND
            (r.warehouse_id IS NULL OR r.warehouse_id=ANY($3::bigint[]))))`,
      [actor.role==='MANAGER',actor.id,actor.warehouses]),
      actor.role==='MANAGER' ? getValuation(pool) : Promise.resolve(null),
    ]);
    res.json({...common,work:{
      orders:orders.rows[0],transfers:transfers.rows[0],
      [actor.role==='MANAGER'?'pendingApprovals':'myOpenRequests']:requests.rows[0].count,
    },...(valuation ? {valuation} : {})});
  });
  return router;
}
