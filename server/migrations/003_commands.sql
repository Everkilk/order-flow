SET LOCAL search_path=orderflow,pg_catalog;

-- These are trusted-backend commands, not authentication endpoints. actor_id must
-- come from the authenticated session. Functions run with caller permissions.
CREATE FUNCTION command_retry(p_key uuid,p_type text,p_source bigint,p_actor bigint) RETURNS bigint
LANGUAGE plpgsql SET search_path=orderflow,pg_catalog AS $$
DECLARE e inventory_events%ROWTYPE;
BEGIN
  PERFORM assert_actor(p_actor);
  IF p_key IS NULL THEN RAISE EXCEPTION 'An idempotency key is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key::text,0));
  SELECT * INTO e FROM inventory_events WHERE idempotency_key=p_key;
  IF FOUND THEN
    IF e.event_type<>p_type OR e.actor_id<>p_actor OR
       coalesce(e.order_id,e.receipt_id,e.order_return_id,e.transfer_id,e.transfer_receipt_id,e.resolution_id,e.decision_id)<>p_source THEN
      RAISE EXCEPTION 'Idempotency key was already used for another command' USING ERRCODE='23514';
    END IF;
    RETURN e.id;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION post_receipt(p_receipt bigint,p_actor bigint,p_key uuid) RETURNS bigint
LANGUAGE plpgsql SET search_path=orderflow,pg_catalog AS $$
DECLARE d receipts%ROWTYPE; item record; eid bigint; kind text;
BEGIN
  SELECT * INTO STRICT d FROM receipts WHERE id=p_receipt;
  kind:=CASE WHEN d.kind='OPENING' THEN 'OPENING' ELSE 'RECEIPT' END;
  eid:=command_retry(p_key,kind,p_receipt,p_actor);
  IF eid IS NOT NULL THEN RETURN eid; END IF;
  SELECT * INTO STRICT d FROM receipts WHERE id=p_receipt FOR UPDATE;
  PERFORM assert_actor(p_actor,d.kind='OPENING');
  IF d.status<>'DRAFT' THEN RAISE EXCEPTION 'Receipt is already posted' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM receipt_items WHERE receipt_id=p_receipt) THEN RAISE EXCEPTION 'Receipt needs an item'; END IF;
  INSERT INTO inventory_events(event_type,actor_id,idempotency_key,reason,receipt_id)
    VALUES(kind,p_actor,p_key,coalesce(nullif(d.note,''),'Post receipt '||d.receipt_number),p_receipt) RETURNING id INTO eid;
  FOR item IN SELECT * FROM receipt_items WHERE receipt_id=p_receipt ORDER BY product_id LOOP
    INSERT INTO inventory_ledger(event_id,product_id,warehouse_id,receipt_item_id,on_hand_delta,reserved_delta)
      VALUES(eid,item.product_id,d.warehouse_id,item.id,item.quantity,0);
  END LOOP;
  UPDATE receipts SET status='POSTED',posted_at=clock_timestamp() WHERE id=p_receipt;
  RETURN eid;
END $$;

CREATE FUNCTION change_order(p_order bigint,p_actor bigint,p_key uuid,p_action text) RETURNS bigint
LANGUAGE plpgsql SET search_path=orderflow,pg_catalog AS $$
DECLARE d orders%ROWTYPE; item record; eid bigint; current_qty numeric; expected_status text;
BEGIN
  IF p_action NOT IN ('ORDER_CONFIRM','ORDER_CANCEL','ORDER_FULFILL') THEN RAISE EXCEPTION 'Invalid order command'; END IF;
  eid:=command_retry(p_key,p_action,p_order,p_actor);
  IF eid IS NOT NULL THEN RETURN eid; END IF;
  SELECT * INTO STRICT d FROM orders WHERE id=p_order FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM users WHERE id=p_actor AND role='MANAGER') AND
    p_actor<>d.created_by AND p_actor IS DISTINCT FROM d.assigned_to THEN
    RAISE EXCEPTION 'Order belongs to another staff member' USING ERRCODE='42501';
  END IF;
  expected_status:=CASE WHEN p_action='ORDER_CONFIRM' THEN 'DRAFT' ELSE 'CONFIRMED' END;
  IF d.status<>expected_status THEN RAISE EXCEPTION 'Order must be %',expected_status USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM order_items WHERE order_id=p_order) THEN RAISE EXCEPTION 'Order needs an item'; END IF;
  -- All balance locks are obtained in warehouse/product order before posting.
  FOR item IN SELECT * FROM order_items WHERE order_id=p_order ORDER BY warehouse_id,product_id LOOP
    SELECT available INTO current_qty FROM inventory_balances
      WHERE warehouse_id=item.warehouse_id AND product_id=item.product_id FOR UPDATE;
    IF NOT FOUND OR (p_action='ORDER_CONFIRM' AND current_qty<item.quantity) THEN
      RAISE EXCEPTION 'Insufficient available stock for product % in warehouse %',item.product_id,item.warehouse_id USING ERRCODE='23514';
    END IF;
    IF p_action='ORDER_CONFIRM' AND (
      NOT EXISTS(SELECT 1 FROM products WHERE id=item.product_id AND active) OR
      NOT EXISTS(SELECT 1 FROM warehouses WHERE id=item.warehouse_id AND active)) THEN
      RAISE EXCEPTION 'Order contains an inactive product or warehouse' USING ERRCODE='23514';
    END IF;
  END LOOP;
  INSERT INTO inventory_events(event_type,actor_id,idempotency_key,reason,order_id)
    VALUES(p_action,p_actor,p_key,p_action||' '||d.order_number,p_order) RETURNING id INTO eid;
  FOR item IN SELECT * FROM order_items WHERE order_id=p_order ORDER BY warehouse_id,product_id LOOP
    INSERT INTO inventory_ledger(event_id,product_id,warehouse_id,order_item_id,on_hand_delta,reserved_delta)
      VALUES(eid,item.product_id,item.warehouse_id,item.id,
        CASE WHEN p_action='ORDER_FULFILL' THEN -item.quantity ELSE 0 END,
        CASE WHEN p_action='ORDER_CONFIRM' THEN item.quantity ELSE -item.quantity END);
  END LOOP;
  IF p_action='ORDER_CONFIRM' THEN UPDATE orders SET status='CONFIRMED',confirmed_at=clock_timestamp() WHERE id=p_order;
  ELSIF p_action='ORDER_CANCEL' THEN UPDATE orders SET status='CANCELLED',cancelled_at=clock_timestamp() WHERE id=p_order;
  ELSE UPDATE orders SET status='FULFILLED',fulfilled_at=clock_timestamp() WHERE id=p_order;
  END IF;
  RETURN eid;
END $$;
CREATE FUNCTION confirm_order(p_order bigint,p_actor bigint,p_key uuid) RETURNS bigint
LANGUAGE sql SET search_path=orderflow,pg_catalog AS $$ SELECT change_order(p_order,p_actor,p_key,'ORDER_CONFIRM') $$;
CREATE FUNCTION cancel_order(p_order bigint,p_actor bigint,p_key uuid) RETURNS bigint
LANGUAGE sql SET search_path=orderflow,pg_catalog AS $$ SELECT change_order(p_order,p_actor,p_key,'ORDER_CANCEL') $$;
CREATE FUNCTION fulfill_order(p_order bigint,p_actor bigint,p_key uuid) RETURNS bigint
LANGUAGE sql SET search_path=orderflow,pg_catalog AS $$ SELECT change_order(p_order,p_actor,p_key,'ORDER_FULFILL') $$;

CREATE FUNCTION post_order_return(p_return bigint,p_actor bigint,p_key uuid) RETURNS bigint
LANGUAGE plpgsql SET search_path=orderflow,pg_catalog AS $$
DECLARE d order_returns%ROWTYPE; item record; eid bigint;
BEGIN
  eid:=command_retry(p_key,'ORDER_RETURN',p_return,p_actor);
  IF eid IS NOT NULL THEN RETURN eid; END IF;
  SELECT * INTO STRICT d FROM order_returns WHERE id=p_return FOR UPDATE;
  IF d.status<>'DRAFT' THEN RAISE EXCEPTION 'Return is already posted' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM order_return_items WHERE return_id=p_return) THEN RAISE EXCEPTION 'Return needs an item'; END IF;
  INSERT INTO inventory_events(event_type,actor_id,idempotency_key,reason,order_return_id)
    VALUES('ORDER_RETURN',p_actor,p_key,d.reason,p_return) RETURNING id INTO eid;
  FOR item IN SELECT ri.*,oi.product_id FROM order_return_items ri JOIN order_items oi ON oi.id=ri.order_item_id
    WHERE ri.return_id=p_return ORDER BY oi.product_id,oi.id LOOP
    INSERT INTO inventory_ledger(event_id,product_id,warehouse_id,return_item_id,on_hand_delta,reserved_delta)
      VALUES(eid,item.product_id,d.warehouse_id,item.id,item.quantity,0);
  END LOOP;
  UPDATE order_returns SET status='POSTED' WHERE id=p_return;
  RETURN eid;
END $$;

CREATE FUNCTION send_transfer(p_transfer bigint,p_actor bigint,p_key uuid) RETURNS bigint
LANGUAGE plpgsql SET search_path=orderflow,pg_catalog AS $$
DECLARE d transfers%ROWTYPE; item record; eid bigint;
BEGIN
  eid:=command_retry(p_key,'TRANSFER_SEND',p_transfer,p_actor);
  IF eid IS NOT NULL THEN RETURN eid; END IF;
  SELECT * INTO STRICT d FROM transfers WHERE id=p_transfer FOR UPDATE;
  IF d.status<>'DRAFT' THEN RAISE EXCEPTION 'Transfer must be a draft' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM transfer_items WHERE transfer_id=p_transfer) THEN RAISE EXCEPTION 'Transfer needs an item'; END IF;
  UPDATE transfer_items SET sent_qty=requested_qty WHERE transfer_id=p_transfer;
  INSERT INTO inventory_events(event_type,actor_id,idempotency_key,reason,transfer_id)
    VALUES('TRANSFER_SEND',p_actor,p_key,'Send transfer '||d.transfer_number,p_transfer) RETURNING id INTO eid;
  FOR item IN SELECT * FROM transfer_items WHERE transfer_id=p_transfer ORDER BY product_id LOOP
    INSERT INTO inventory_ledger(event_id,product_id,warehouse_id,transfer_item_id,on_hand_delta,reserved_delta)
      VALUES(eid,item.product_id,d.source_warehouse_id,item.id,-item.sent_qty,0);
  END LOOP;
  UPDATE transfers SET status='SENT',sent_at=clock_timestamp() WHERE id=p_transfer;
  RETURN eid;
END $$;

-- Public SQL access is not granted. The API will receive an explicit role with
-- permissions appropriate to its service layer, separate from the migration owner.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA orderflow FROM PUBLIC;
