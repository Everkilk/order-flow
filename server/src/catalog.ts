import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { AppError } from './errors.js';
import { requireActor, requireRole, warehouseAllowed, type Actor } from './auth.js';
import { withTransaction } from './db.js';

const id = z.string().regex(/^[1-9]\d*$/);
const amount = z.string().regex(/^\d+(?:\.\d{1,4})?$/).refine(s => new Decimal(s).isFinite());
const categoryInput = z.object({ name: z.string().trim().min(1).max(160) }).strict();
const attributeInput = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*$/), label: z.string().trim().min(1).max(160),
  dataType: z.enum(['string','number','boolean']), required: z.boolean().default(false), unitLabel: z.string().max(80).nullable().optional(),
  minValue: z.number().finite().nullable().optional(), maxValue: z.number().finite().nullable().optional(),
  allowedValues: z.array(z.union([z.string(),z.number().finite(),z.boolean()])).min(1).nullable().optional() }).strict();
const productInput = z.object({ sku: z.string().trim().min(1).max(100), barcode: z.string().trim().min(1).max(100).nullable().optional(),
  name: z.string().trim().min(1).max(240), categoryId: id, unitId: id,
  description:z.string().max(5000).nullable().optional(),imageUrl:z.url().max(1000).nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).default({}), sellingPrice: amount.nullable().optional(),
  sellingCurrency: z.enum(['VND','USD']).nullable().optional() }).strict();
const productUpdate = productInput.extend({ expectedRevision:z.coerce.number().int().nonnegative(),active:z.boolean() });
const supplierLink = z.object({ supplierId:id,supplierSku:z.string().max(100).nullable().optional(),primarySupplier:z.boolean().default(false),
  cost:amount.nullable().optional(),currency:z.enum(['VND','USD']).nullable().optional() }).strict();
const listInput = z.object({ q: z.string().trim().max(120).default(''), categoryId: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(600).optional() }).strict();

function validateAttributes(definitions: Record<string, unknown>[], attrs: Record<string, unknown>) {
  const known = new Map(definitions.map(d => [String(d.key), d]));
  for (const key of Object.keys(attrs)) if (!known.has(key)) throw new AppError(422, 'INVALID_ATTRIBUTES', `Unknown attribute: ${key}.`);
  for (const definition of definitions) {
    const key = String(definition.key);
    if (!(key in attrs)) {
      if (definition.required) throw new AppError(422, 'INVALID_ATTRIBUTES', `Required attribute missing: ${key}.`);
      continue;
    }
    const value = attrs[key];
    if (value === null || typeof value !== definition.data_type ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (definition.required && typeof value === 'string' && !value.trim()))
      throw new AppError(422, 'INVALID_ATTRIBUTES', `Invalid value for ${key}.`);
    if (typeof value === 'number') {
      if (definition.min_value !== null && value < Number(definition.min_value)) throw new AppError(422, 'INVALID_ATTRIBUTES', `${key} is below its minimum.`);
      if (definition.max_value !== null && value > Number(definition.max_value)) throw new AppError(422, 'INVALID_ATTRIBUTES', `${key} exceeds its maximum.`);
    }
    if (definition.allowed_values && !Array.isArray(definition.allowed_values)) throw new Error('Invalid attribute definition.');
    if (Array.isArray(definition.allowed_values) && !definition.allowed_values.some((allowed: unknown) => allowed === value))
      throw new AppError(422, 'INVALID_ATTRIBUTES', `${key} is not an allowed value.`);
  }
}

const actorOf = (res: { locals: Record<string, unknown> }) => res.locals.actor as Actor;

export function catalogRoutes(pool: pg.Pool): Router {
  const router = Router();
  router.get('/categories', requireActor, async (_req, res) => {
    const rows = await pool.query('SELECT id::text,name,active FROM orderflow.categories WHERE active ORDER BY name,id LIMIT 500');
    res.json({ items: rows.rows });
  });
  router.post('/categories', requireRole('MANAGER'), async (req, res) => {
    const input = categoryInput.parse(req.body);
    const actor = actorOf(res);
    const row = await withTransaction(pool, async client => {
      const result = await client.query('INSERT INTO orderflow.categories(name) VALUES($1) RETURNING id::text,name,active', [input.name]);
      await client.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'CATEGORY_CREATE','category',$2)", [actor.id, result.rows[0].id]);
      return result.rows[0];
    });
    res.status(201).json(row);
  });
  router.patch('/categories/:id', requireRole('MANAGER'), async (req,res) => {
    const categoryId=id.parse(req.params.id);
    const input=z.object({name:z.string().trim().min(1).max(160).optional(),active:z.boolean().optional()}).strict().parse(req.body);
    if (!Object.keys(input).length) throw new AppError(400,'VALIDATION_ERROR','Provide a field to change.');
    const actor=actorOf(res);
    await withTransaction(pool,async c => {
      const before=await c.query('SELECT name,active FROM orderflow.categories WHERE id=$1 FOR UPDATE',[categoryId]);
      if (!before.rowCount) throw new AppError(404,'NOT_FOUND','Category not found.');
      await c.query('UPDATE orderflow.categories SET name=$1,active=$2 WHERE id=$3',[input.name ?? before.rows[0].name,input.active ?? before.rows[0].active,categoryId]);
      await c.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id,details) VALUES($1,'CATEGORY_UPDATE','category',$2,$3)",[actor.id,categoryId,JSON.stringify(input)]);
    });
    res.status(204).end();
  });
  router.get('/categories/:id/attributes', requireActor, async (req, res) => {
    const categoryId = id.parse(req.params.id);
    const category = await pool.query('SELECT 1 FROM orderflow.categories WHERE id=$1', [categoryId]);
    if (!category.rowCount) throw new AppError(404, 'NOT_FOUND', 'Category not found.');
    const result = await pool.query('SELECT id::text,key,label,data_type AS "dataType",required,unit_label AS "unitLabel",min_value::text AS "minValue",max_value::text AS "maxValue",allowed_values AS "allowedValues" FROM orderflow.category_attributes WHERE category_id=$1 ORDER BY id', [categoryId]);
    res.json({ items: result.rows });
  });
  router.post('/categories/:id/attributes', requireRole('MANAGER'), async (req, res) => {
    const categoryId = id.parse(req.params.id);
    const input = attributeInput.parse(req.body);
    if ((input.minValue != null || input.maxValue != null) && input.dataType !== 'number') throw new AppError(422, 'INVALID_ATTRIBUTE', 'Ranges require a numeric attribute.');
    if (input.minValue != null && input.maxValue != null && input.minValue > input.maxValue) throw new AppError(422, 'INVALID_ATTRIBUTE', 'Minimum exceeds maximum.');
    if (input.allowedValues?.some(v => typeof v !== input.dataType)) throw new AppError(422, 'INVALID_ATTRIBUTE', 'Allowed values must match the attribute type.');
    const actor = actorOf(res);
    const row = await withTransaction(pool, async client => {
      const category = await client.query('SELECT id FROM orderflow.categories WHERE id=$1 FOR UPDATE', [categoryId]);
      if (!category.rowCount) throw new AppError(404, 'NOT_FOUND', 'Category not found.');
      const result = await client.query(`INSERT INTO orderflow.category_attributes(category_id,key,label,data_type,required,unit_label,min_value,max_value,allowed_values)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text,key,label,data_type AS "dataType",required`,
        [categoryId,input.key,input.label,input.dataType,input.required,input.unitLabel ?? null,input.minValue ?? null,input.maxValue ?? null,input.allowedValues ? JSON.stringify(input.allowedValues) : null]);
      await client.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'ATTRIBUTE_CREATE','category_attribute',$2)", [actor.id, result.rows[0].id]);
      return result.rows[0];
    });
    res.status(201).json(row);
  });
  router.get('/units', requireActor, async (_req, res) => {
    const rows = await pool.query('SELECT id::text,code,name,decimal_places AS "decimalPlaces" FROM orderflow.units ORDER BY name,id LIMIT 500');
    res.json({ items: rows.rows });
  });
  router.get('/warehouses', requireActor, async (_req, res) => {
    const actor = actorOf(res);
    const rows = await pool.query('SELECT id::text,code,name FROM orderflow.warehouses WHERE active AND ($1 OR id=ANY($2::bigint[])) ORDER BY code,id LIMIT 500', [actor.role === 'MANAGER',actor.warehouses]);
    res.json({ items: rows.rows });
  });
  router.post('/products', requireRole('MANAGER'), async (req, res) => {
    const input = productInput.parse(req.body);
    if ((input.sellingPrice == null) !== (input.sellingCurrency == null)) throw new AppError(422, 'INVALID_PRICE', 'Price and currency must be supplied together.');
    const actor = actorOf(res);
    const product = await withTransaction(pool, async client => {
      const category = await client.query('SELECT id FROM orderflow.categories WHERE id=$1 AND active FOR SHARE', [input.categoryId]);
      if (!category.rowCount) throw new AppError(422, 'INVALID_CATEGORY', 'Choose an active category.');
      const unit = await client.query('SELECT id FROM orderflow.units WHERE id=$1', [input.unitId]);
      if (!unit.rowCount) throw new AppError(422, 'INVALID_UNIT', 'Choose an existing unit.');
      const definitions = await client.query('SELECT key,data_type,required,min_value,max_value,allowed_values FROM orderflow.category_attributes WHERE category_id=$1', [input.categoryId]);
      validateAttributes(definitions.rows,input.attributes);
      const result = await client.query(`INSERT INTO orderflow.products
        (sku,barcode,name,category_id,unit_id,description,image_url,attributes,selling_price,selling_currency)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id::text,sku,barcode,name,description,image_url AS "imageUrl",
        category_id::text AS "categoryId",unit_id::text AS "unitId",attributes,
        selling_price::text AS "sellingPrice",selling_currency AS "sellingCurrency",active,revision::text`,
        [input.sku,input.barcode ?? null,input.name,input.categoryId,input.unitId,
          input.description ?? null,input.imageUrl ?? null,JSON.stringify(input.attributes),
          input.sellingPrice ?? null,input.sellingCurrency ?? null]);
      await client.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'PRODUCT_CREATE','product',$2)", [actor.id,result.rows[0].id]);
      return result.rows[0];
    });
    res.status(201).json(product);
  });
  router.put('/products/:id', requireRole('MANAGER'), async (req,res) => {
    const productId=id.parse(req.params.id), input=productUpdate.parse(req.body), actor=actorOf(res);
    if ((input.sellingPrice == null)!==(input.sellingCurrency == null)) throw new AppError(422,'INVALID_PRICE','Price and currency must be supplied together.');
    const product=await withTransaction(pool,async c => {
      const category=await c.query('SELECT id FROM orderflow.categories WHERE id=$1 AND active FOR SHARE',[input.categoryId]);
      if (!category.rowCount) throw new AppError(422,'INVALID_CATEGORY','Choose an active category.');
      const before=await c.query('SELECT revision,description,image_url FROM orderflow.products WHERE id=$1 FOR UPDATE',[productId]);
      if (!before.rowCount) throw new AppError(404,'NOT_FOUND','Product not found.');
      if (Number(before.rows[0].revision)!==input.expectedRevision) throw new AppError(409,'STALE_REVISION','Product changed; reload before saving.');
      const definitions=await c.query('SELECT key,data_type,required,min_value,max_value,allowed_values FROM orderflow.category_attributes WHERE category_id=$1',[input.categoryId]);
      validateAttributes(definitions.rows,input.attributes);
      const result=await c.query(`UPDATE orderflow.products SET sku=$1,barcode=$2,name=$3,category_id=$4,unit_id=$5,
        description=$6,image_url=$7,attributes=$8,selling_price=$9,selling_currency=$10,
        active=$11,revision=revision+1 WHERE id=$12
        RETURNING id::text,sku,barcode,name,description,image_url AS "imageUrl",
          attributes,active,revision::text`,
        [input.sku,input.barcode ?? null,input.name,input.categoryId,input.unitId,
          input.description===undefined?before.rows[0].description:input.description,
          input.imageUrl===undefined?before.rows[0].image_url:input.imageUrl,
          JSON.stringify(input.attributes),input.sellingPrice ?? null,input.sellingCurrency ?? null,
          input.active,productId]);
      await c.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'PRODUCT_UPDATE','product',$2)",[actor.id,productId]);
      return result.rows[0];
    });
    res.json(product);
  });
  router.put('/products/:id/suppliers/:supplierId', requireRole('MANAGER'), async(req,res) => {
    const productId=id.parse(req.params.id), supplierId=id.parse(req.params.supplierId),input=supplierLink.parse({ ...req.body,supplierId:req.params.supplierId });
    if ((input.cost == null)!==(input.currency == null)) throw new AppError(422,'INVALID_COST','Cost and currency must be supplied together.');
    const actor=actorOf(res);
    await withTransaction(pool,async c => {
      await c.query(`INSERT INTO orderflow.product_suppliers(product_id,supplier_id,supplier_sku,primary_supplier,cost,currency)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(product_id,supplier_id) DO UPDATE SET
        supplier_sku=excluded.supplier_sku,primary_supplier=excluded.primary_supplier,cost=excluded.cost,currency=excluded.currency`,
        [productId,supplierId,input.supplierSku ?? null,input.primarySupplier,input.cost ?? null,input.currency ?? null]);
      await c.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'PRODUCT_SUPPLIER_SET','product',$2)",[actor.id,productId]);
    });
    res.status(204).end();
  });
  router.get('/products/:id', requireActor, async (req, res) => {
    const productId = id.parse(req.params.id);
    const actor = actorOf(res);
    const product = await pool.query(`SELECT p.id::text,p.sku,p.barcode,p.name,p.description,p.image_url AS "imageUrl",
      p.attributes,p.active,p.category_id::text AS "categoryId",
      p.unit_id::text AS "unitId",p.selling_price::text AS "sellingPrice",p.selling_currency AS "sellingCurrency",p.revision::text,c.name AS category,
      u.code AS unit FROM orderflow.products p JOIN orderflow.categories c ON c.id=p.category_id JOIN orderflow.units u ON u.id=p.unit_id WHERE p.id=$1`, [productId]);
    if (!product.rowCount) throw new AppError(404, 'NOT_FOUND', 'Product not found.');
    const stock = await pool.query(`SELECT b.warehouse_id::text AS "warehouseId",w.code AS warehouse,b.on_hand::text AS "onHand",
      b.reserved::text AS reserved,b.available::text AS available FROM orderflow.inventory_balances b JOIN orderflow.warehouses w ON w.id=b.warehouse_id
      WHERE b.product_id=$1 AND ($2 OR b.warehouse_id=ANY($3::bigint[])) ORDER BY w.code`, [productId,actor.role === 'MANAGER',actor.warehouses]);
    const supplierColumns=actor.role==='MANAGER' ? ',ps.cost::text AS cost,ps.currency' : '';
    const suppliers=await pool.query(`SELECT s.id::text,s.name,ps.supplier_sku AS "supplierSku",ps.primary_supplier AS "primarySupplier"${supplierColumns}
      FROM orderflow.product_suppliers ps JOIN orderflow.suppliers s ON s.id=ps.supplier_id
      WHERE ps.product_id=$1 ORDER BY ps.primary_supplier DESC,s.name`,[productId]);
    res.json({ ...product.rows[0], stock: stock.rows,suppliers:suppliers.rows });
  });
  router.get('/products', requireActor, async (req, res) => {
    const input = listInput.parse(req.query);
    const actor = actorOf(res);
    let afterScore = -1, afterId = '0';
    if (input.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()) as { score:number; id:string; q:string; categoryId?:string };
        if (parsed.q !== input.q || parsed.categoryId !== input.categoryId || !Number.isInteger(parsed.score) || !id.safeParse(parsed.id).success) throw new Error('cursor mismatch');
        afterScore = parsed.score; afterId = parsed.id;
      } catch { throw new AppError(400, 'INVALID_CURSOR', 'Cursor is invalid for this search.'); }
    }
    const result = await pool.query(`WITH matches AS (
      SELECT p.id,p.sku,p.barcode,p.name,p.image_url,p.category_id,p.active,
        CASE WHEN $1='' THEN 0 WHEN p.sku=$1 OR p.barcode=$1 THEN 0
          WHEN p.sku LIKE $1||'%' THEN 1 WHEN lower(p.name) LIKE lower($1)||'%' THEN 2 ELSE 3 END AS score
      FROM orderflow.products p WHERE p.active AND ($2::bigint IS NULL OR p.category_id=$2)
        AND ($1='' OR p.sku=$1 OR p.barcode=$1 OR p.sku LIKE $1||'%' OR lower(p.name) LIKE lower($1)||'%'
          OR to_tsvector('simple',p.name) @@ plainto_tsquery('simple',$1))
    ) SELECT m.id::text,m.sku,m.barcode,m.name,m.image_url AS "imageUrl",
      m.category_id::text AS "categoryId",c.name AS category,m.score
    FROM matches m JOIN orderflow.categories c ON c.id=m.category_id
    WHERE m.score>$3 OR (m.score=$3 AND m.id>$4::bigint)
    ORDER BY m.score,m.id LIMIT $5`, [input.q,input.categoryId ?? null,afterScore,afterId,input.limit+1]);
    const hasMore = result.rows.length > input.limit;
    const items = result.rows.slice(0,input.limit);
    const last = items.at(-1);
    const cursor = hasMore && last ? Buffer.from(JSON.stringify({ score:last.score,id:last.id,q:input.q,categoryId:input.categoryId })).toString('base64url') : null;
    res.json({ items: items.map(({score,...item}) => item), nextCursor: cursor });
  });
  return router;
}
