-- Historical SQL lesson for migrations 001-004 only. Current deployments use
-- the TypeScript API after migrations 005-006; run npm run db:demo instead.
-- Open this file in pgAdmin's Query Tool connected to the orderflow database.
-- Execute the WHOLE file. It creates example rows, shows results, then rolls back.
-- PostgreSQL identity sequences may advance even though the rows are rolled back.
BEGIN;
SET LOCAL search_path=orderflow,pg_catalog;

CREATE TEMP TABLE lesson_results (
  stage integer, explanation text, on_hand numeric, reserved numeric, available numeric
) ON COMMIT DROP;
CREATE TEMP TABLE lesson_product (id bigint) ON COMMIT DROP;

DO $$
<<lesson>>
DECLARE
  manager_id bigint; category_id bigint; unit_id bigint; warehouse_id bigint;
  product_id bigint; receipt_id bigint; order_id bigint;
  confirm_key uuid := gen_random_uuid();
  example_suffix text := gen_random_uuid()::text;
BEGIN
  -- RETURNING id gives us the primary key created by PostgreSQL.
  -- This example account has no usable password and is rolled back below.
  INSERT INTO users(email,display_name,password_hash,role)
    VALUES('lesson-'||example_suffix||'@example.invalid','Lesson manager','DEMO_ONLY_NO_LOGIN','MANAGER')
    RETURNING id INTO manager_id;

  INSERT INTO units(code,name,decimal_places)
    VALUES('piece-'||example_suffix,'Piece',0) RETURNING id INTO unit_id;
  INSERT INTO categories(name)
    VALUES('Lesson phones '||example_suffix) RETURNING id INTO category_id;

  -- This defines the field; it does not store an individual phone's value.
  INSERT INTO category_attributes(category_id,key,label,data_type,required,unit_label,min_value)
    VALUES(category_id,'screen_size_inches','Screen size','number',true,'inches',0.1);

  -- The individual product's value lives in this JSONB object.
  INSERT INTO products(sku,name,category_id,unit_id,attributes,selling_price,selling_currency)
    VALUES('LESSON-'||example_suffix,'Example phone',category_id,unit_id,
           '{"screen_size_inches":6.1}'::jsonb,10000000,'VND')
    RETURNING id INTO product_id;
  INSERT INTO lesson_product VALUES(product_id);
  INSERT INTO warehouses(code,name)
    VALUES('MAIN-'||example_suffix,'Lesson warehouse') RETURNING id INTO warehouse_id;

  -- Describe the incoming stock, then post it through a command.
  INSERT INTO receipts(receipt_number,kind,warehouse_id,created_by,note)
    VALUES('OPEN-'||example_suffix,'OPENING',warehouse_id,manager_id,'Start with ten phones')
    RETURNING id INTO receipt_id;
  INSERT INTO receipt_items(receipt_id,product_id,quantity) VALUES(receipt_id,product_id,10);
  PERFORM post_receipt(receipt_id,manager_id,gen_random_uuid());
  INSERT INTO lesson_results
    SELECT 1,'Received 10 phones',b.on_hand,b.reserved,b.available
    FROM inventory_balances b WHERE b.product_id=lesson.product_id AND b.warehouse_id=lesson.warehouse_id;

  INSERT INTO orders(order_number,created_by)
    VALUES('ORDER-'||example_suffix,manager_id) RETURNING id INTO order_id;
  INSERT INTO order_items(order_id,product_id,warehouse_id,quantity)
    VALUES(order_id,product_id,warehouse_id,3);
  INSERT INTO lesson_results
    SELECT 2,'Draft order for 3: nothing reserved',b.on_hand,b.reserved,b.available
    FROM inventory_balances b WHERE b.product_id=lesson.product_id AND b.warehouse_id=lesson.warehouse_id;

  PERFORM confirm_order(order_id,manager_id,confirm_key);
  INSERT INTO lesson_results
    SELECT 3,'Confirmed: 3 reserved',b.on_hand,b.reserved,b.available
    FROM inventory_balances b WHERE b.product_id=lesson.product_id AND b.warehouse_id=lesson.warehouse_id;

  -- Retrying the SAME action uses the SAME key. It returns the original event.
  PERFORM confirm_order(order_id,manager_id,confirm_key);
  INSERT INTO lesson_results
    SELECT 4,'Retried confirmation: no duplicate reservation',b.on_hand,b.reserved,b.available
    FROM inventory_balances b WHERE b.product_id=lesson.product_id AND b.warehouse_id=lesson.warehouse_id;

  -- Fulfillment is a different action, so it gets a new key.
  PERFORM fulfill_order(order_id,manager_id,gen_random_uuid());
  INSERT INTO lesson_results
    SELECT 5,'Fulfilled: 3 leave the warehouse',b.on_hand,b.reserved,b.available
    FROM inventory_balances b WHERE b.product_id=lesson.product_id AND b.warehouse_id=lesson.warehouse_id;
END $$;

-- Run deferred consistency checks now, even though the lesson will roll back.
SET CONSTRAINTS ALL IMMEDIATE;
SELECT * FROM lesson_results ORDER BY stage;
SELECT e.event_type,l.on_hand_delta,l.reserved_delta,
       l.on_hand_before,l.on_hand_after,l.reserved_before,l.reserved_after
FROM inventory_ledger l JOIN inventory_events e ON e.id=l.event_id
WHERE l.product_id IN (SELECT id FROM lesson_product) ORDER BY l.id;
ROLLBACK;
