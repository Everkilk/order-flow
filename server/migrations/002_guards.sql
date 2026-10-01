SET LOCAL search_path = orderflow, pg_catalog;

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; create a linked correction', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_events','inventory_ledger','audit_events',
    'transfer_receipts','transfer_receipt_items','transfer_discrepancies','discrepancy_resolutions',
    'stock_change_requests','stock_change_decisions','evidence_files','discrepancy_evidence',
    'stock_request_evidence','delivery_attempts'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_mutation()',t);
    EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation()',t);
  END LOOP;
END $$;

CREATE FUNCTION assert_actor(p_actor bigint, p_manager boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path = orderflow, pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_actor AND active
    AND (role = 'MANAGER' OR (NOT p_manager AND role = 'STAFF'))) THEN
    RAISE EXCEPTION 'An active % is required', CASE WHEN p_manager THEN 'manager' ELSE 'staff member or manager' END
      USING ERRCODE = '42501';
  END IF;
END $$;

CREATE FUNCTION protect_last_manager() RETURNS trigger LANGUAGE plpgsql
SET search_path = orderflow, pg_catalog AS $$
BEGIN
  -- Serialize all manager membership changes, including concurrent demotions.
  PERFORM pg_advisory_xact_lock(742019, 1);
  IF OLD.role = 'MANAGER' AND OLD.active AND
    (TG_OP = 'DELETE' OR NOT NEW.active OR NEW.role <> 'MANAGER') AND
    NOT EXISTS (SELECT 1 FROM users WHERE role = 'MANAGER' AND active AND id <> OLD.id) THEN
    RAISE EXCEPTION 'The last active manager cannot be removed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER last_manager BEFORE UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION protect_last_manager();

CREATE FUNCTION validate_attributes(p_category bigint, p_values jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = orderflow, pg_catalog AS $$
DECLARE a record; k text; v jsonb;
BEGIN
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Product attributes must be a JSON object' USING ERRCODE = '23514';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_values) LOOP
    IF NOT EXISTS (SELECT 1 FROM category_attributes WHERE category_id = p_category AND key = k) THEN
      RAISE EXCEPTION 'Unknown attribute: %', k USING ERRCODE = '23514';
    END IF;
  END LOOP;
  FOR a IN SELECT * FROM category_attributes WHERE category_id = p_category LOOP
    IF NOT p_values ? a.key THEN
      IF a.required THEN RAISE EXCEPTION 'Required attribute missing: %', a.key USING ERRCODE = '23514'; END IF;
      CONTINUE;
    END IF;
    v := p_values -> a.key;
    IF jsonb_typeof(v) IS DISTINCT FROM a.data_type THEN
      RAISE EXCEPTION 'Attribute % must be %', a.key, a.data_type USING ERRCODE = '23514';
    END IF;
    IF a.required AND a.data_type = 'string' AND btrim(v #>> '{}') = '' THEN
      RAISE EXCEPTION 'Required attribute % cannot be blank', a.key USING ERRCODE = '23514';
    END IF;
    IF a.data_type = 'number' THEN
      IF (a.min_value IS NOT NULL AND (v #>> '{}')::numeric < a.min_value) OR
         (a.max_value IS NOT NULL AND (v #>> '{}')::numeric > a.max_value) THEN
        RAISE EXCEPTION 'Attribute % is outside its allowed range', a.key USING ERRCODE = '23514';
      END IF;
    END IF;
    IF a.allowed_values IS NOT NULL AND NOT a.allowed_values @> jsonb_build_array(v) THEN
      RAISE EXCEPTION 'Attribute % is not an allowed value', a.key USING ERRCODE = '23514';
    END IF;
  END LOOP;
END $$;
CREATE FUNCTION validate_product() RETURNS trigger LANGUAGE plpgsql
SET search_path = orderflow, pg_catalog AS $$
BEGIN
  PERFORM 1 FROM categories WHERE id = NEW.category_id FOR SHARE;
  PERFORM validate_attributes(NEW.category_id, NEW.attributes);
  IF TG_OP = 'UPDATE' AND NEW.unit_id <> OLD.unit_id AND
     EXISTS (SELECT 1 FROM inventory_ledger WHERE product_id = OLD.id) THEN
    RAISE EXCEPTION 'A product unit cannot change after stock movements' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER product_attributes BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION validate_product();
CREATE FUNCTION lock_attribute_category() RETURNS trigger LANGUAGE plpgsql
SET search_path = orderflow, pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.category_id <> OLD.category_id THEN
    RAISE EXCEPTION 'Create a new definition to move an attribute between categories';
  END IF;
  PERFORM 1 FROM categories WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.category_id ELSE NEW.category_id END FOR UPDATE;
  IF TG_OP <> 'DELETE' AND NEW.allowed_values IS NOT NULL AND
    EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.allowed_values) v WHERE jsonb_typeof(v) <> NEW.data_type) THEN
    RAISE EXCEPTION 'Allowed values must match attribute data_type' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attribute_lock BEFORE INSERT OR UPDATE OR DELETE ON category_attributes
  FOR EACH ROW EXECUTE FUNCTION lock_attribute_category();
CREATE FUNCTION check_existing_attributes() RETURNS trigger LANGUAGE plpgsql
SET search_path = orderflow, pg_catalog AS $$
DECLARE p record; category bigint;
BEGIN
  category := CASE WHEN TG_OP = 'DELETE' THEN OLD.category_id ELSE NEW.category_id END;
  FOR p IN SELECT attributes FROM products WHERE category_id = category LOOP
    PERFORM validate_attributes(category,p.attributes);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER attribute_existing_products AFTER INSERT OR UPDATE OR DELETE ON category_attributes
  FOR EACH ROW EXECUTE FUNCTION check_existing_attributes();

CREATE FUNCTION check_precision(p_product bigint,p_quantity numeric) RETURNS void
LANGUAGE plpgsql SET search_path = orderflow, pg_catalog AS $$
DECLARE places integer;
BEGIN
  SELECT u.decimal_places INTO STRICT places FROM products p JOIN units u ON u.id = p.unit_id WHERE p.id = p_product;
  IF p_quantity <> round(p_quantity,places) THEN
    RAISE EXCEPTION 'Quantity exceeds unit precision for product %', p_product USING ERRCODE = '23514';
  END IF;
END $$;
CREATE FUNCTION guard_unit_precision() RETURNS trigger LANGUAGE plpgsql
SET search_path = orderflow, pg_catalog AS $$
BEGIN
  IF NEW.decimal_places <> OLD.decimal_places AND EXISTS (SELECT 1 FROM products WHERE unit_id = OLD.id) THEN
    RAISE EXCEPTION 'Unit precision is fixed once products use it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixed_unit_precision BEFORE UPDATE ON units FOR EACH ROW EXECUTE FUNCTION guard_unit_precision();

CREATE FUNCTION guard_document_item() RETURNS trigger LANGUAGE plpgsql
SET search_path = orderflow, pg_catalog AS $$
DECLARE doc_id bigint; state text; payload jsonb; product bigint;
BEGIN
  payload := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  doc_id := (payload ->> TG_ARGV[1])::bigint;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD)->>TG_ARGV[1])::bigint <> doc_id THEN
    RAISE EXCEPTION 'Document items cannot move to another document' USING ERRCODE = '23514';
  END IF;
  EXECUTE format('SELECT status FROM %I WHERE id=$1 FOR UPDATE',TG_ARGV[0]) INTO state USING doc_id;
  IF state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Only draft document items can change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    product := (payload->>'product_id')::bigint;
    IF product IS NULL THEN SELECT product_id INTO product FROM order_items WHERE id=(payload->>'order_item_id')::bigint; END IF;
    PERFORM check_precision(product,(payload->>TG_ARGV[2])::numeric);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER draft_item BEFORE INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION guard_document_item('orders','order_id','quantity');
CREATE TRIGGER draft_item BEFORE INSERT OR UPDATE OR DELETE ON receipt_items FOR EACH ROW EXECUTE FUNCTION guard_document_item('receipts','receipt_id','quantity');
CREATE TRIGGER draft_item BEFORE INSERT OR UPDATE OR DELETE ON order_return_items FOR EACH ROW EXECUTE FUNCTION guard_document_item('order_returns','return_id','quantity');
CREATE TRIGGER draft_item BEFORE INSERT OR UPDATE OR DELETE ON transfer_items FOR EACH ROW EXECUTE FUNCTION guard_document_item('transfers','transfer_id','requested_qty');

CREATE FUNCTION guard_balance_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Write inventory_ledger through inventory commands; balances are maintained automatically' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER balance_from_ledger BEFORE INSERT OR UPDATE OR DELETE ON inventory_balances
  FOR EACH ROW EXECUTE FUNCTION guard_balance_write();
CREATE TRIGGER balance_no_truncate BEFORE TRUNCATE ON inventory_balances FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION apply_ledger() RETURNS trigger LANGUAGE plpgsql
SET search_path = orderflow, pg_catalog AS $$
DECLARE e inventory_events%ROWTYPE; src record; b inventory_balances%ROWTYPE;
  wanted_product bigint; wanted_warehouse bigint; hand numeric; held numeric; n integer;
BEGIN
  SELECT * INTO STRICT e FROM inventory_events WHERE id=NEW.event_id;
  PERFORM assert_actor(e.actor_id);
  n := num_nonnulls(NEW.order_item_id,NEW.receipt_item_id,NEW.return_item_id,NEW.transfer_item_id,NEW.transfer_receipt_item_id);
  IF e.event_type IN ('ORDER_CONFIRM','ORDER_CANCEL','ORDER_FULFILL') THEN
    SELECT * INTO STRICT src FROM order_items WHERE id=NEW.order_item_id AND order_id=e.order_id;
    wanted_product := src.product_id; wanted_warehouse := src.warehouse_id;
    hand := CASE WHEN e.event_type='ORDER_FULFILL' THEN -src.quantity ELSE 0 END;
    held := CASE WHEN e.event_type='ORDER_CONFIRM' THEN src.quantity ELSE -src.quantity END;
  ELSIF e.event_type IN ('OPENING','RECEIPT') THEN
    SELECT i.*,r.warehouse_id,r.kind INTO STRICT src FROM receipt_items i JOIN receipts r ON r.id=i.receipt_id
      WHERE i.id=NEW.receipt_item_id AND r.id=e.receipt_id;
    IF (e.event_type='OPENING') <> (src.kind='OPENING') THEN RAISE EXCEPTION 'Receipt kind mismatch'; END IF;
    IF e.event_type='OPENING' THEN PERFORM assert_actor(e.actor_id,true); END IF;
    wanted_product := src.product_id; wanted_warehouse := src.warehouse_id; hand := src.quantity; held := 0;
  ELSIF e.event_type='ORDER_RETURN' THEN
    SELECT i.*,o.product_id,r.warehouse_id,o.quantity AS original_qty,ord.status AS order_status
    INTO STRICT src FROM order_return_items i JOIN order_returns r ON r.id=i.return_id
    JOIN order_items o ON o.id=i.order_item_id JOIN orders ord ON ord.id=o.order_id
    WHERE i.id=NEW.return_item_id AND r.id=e.order_return_id FOR UPDATE OF o;
    IF src.order_status <> 'FULFILLED' OR src.quantity + coalesce((
      SELECT sum(l.on_hand_delta) FROM inventory_ledger l JOIN order_return_items ri ON ri.id=l.return_item_id
      WHERE ri.order_item_id=src.order_item_id),0) > src.original_qty THEN
      RAISE EXCEPTION 'Return exceeds fulfilled quantity or order is not fulfilled' USING ERRCODE='23514';
    END IF;
    wanted_product:=src.product_id; wanted_warehouse:=src.warehouse_id; hand:=src.quantity; held:=0;
  ELSIF e.event_type='TRANSFER_SEND' THEN
    SELECT i.*,t.source_warehouse_id INTO STRICT src FROM transfer_items i JOIN transfers t ON t.id=i.transfer_id
      WHERE i.id=NEW.transfer_item_id AND t.id=e.transfer_id;
    wanted_product:=src.product_id; wanted_warehouse:=src.source_warehouse_id; hand:=-src.sent_qty; held:=0;
  ELSIF e.event_type='TRANSFER_RECEIVE' THEN
    SELECT ri.*,i.product_id,t.destination_warehouse_id INTO STRICT src FROM transfer_receipt_items ri
      JOIN transfer_items i ON i.id=ri.transfer_item_id JOIN transfers t ON t.id=ri.transfer_id
      WHERE ri.id=NEW.transfer_receipt_item_id AND ri.receipt_id=e.transfer_receipt_id;
    wanted_product:=src.product_id; wanted_warehouse:=src.destination_warehouse_id; hand:=src.accepted_qty; held:=0;
  ELSIF e.event_type='TRANSFER_RESOLUTION' THEN
    SELECT r.*,i.product_id,t.source_warehouse_id,t.destination_warehouse_id INTO STRICT src
      FROM discrepancy_resolutions r JOIN transfer_discrepancies d ON d.id=r.discrepancy_id
      JOIN transfer_items i ON i.id=d.transfer_item_id JOIN transfers t ON t.id=i.transfer_id WHERE r.id=e.resolution_id;
    IF src.resolution_type NOT IN ('DISPATCH_CORRECTION','ACCEPT_EXCESS') THEN RAISE EXCEPTION 'This resolution has no warehouse stock movement'; END IF;
    wanted_product:=src.product_id;
    wanted_warehouse:=CASE WHEN src.resolution_type='DISPATCH_CORRECTION' THEN src.source_warehouse_id ELSE src.destination_warehouse_id END;
    hand:=src.quantity; held:=0;
  ELSIF e.event_type='ADJUSTMENT' THEN
    SELECT d.*,r.product_id,r.warehouse_id INTO STRICT src FROM stock_change_decisions d
      JOIN stock_change_requests r ON r.id=d.request_id WHERE d.id=e.decision_id AND d.decision='APPROVED' AND r.request_type <> 'REVERSAL';
    PERFORM assert_actor(e.actor_id,true);
    wanted_product:=src.product_id; wanted_warehouse:=src.warehouse_id; hand:=src.approved_delta; held:=0;
  ELSIF e.event_type='REVERSAL' THEN
    PERFORM assert_actor(e.actor_id,true);
    SELECT -sum(on_hand_delta) AS h,-sum(reserved_delta) AS r INTO src FROM inventory_ledger
      WHERE event_id=e.reversal_of_event_id AND product_id=NEW.product_id AND warehouse_id=NEW.warehouse_id;
    wanted_product:=NEW.product_id; wanted_warehouse:=NEW.warehouse_id; hand:=src.h; held:=src.r;
  END IF;
  IF (e.event_type IN ('ADJUSTMENT','REVERSAL','TRANSFER_RESOLUTION') AND n <> 0) OR
     (e.event_type NOT IN ('ADJUSTMENT','REVERSAL','TRANSFER_RESOLUTION') AND n <> 1) OR
     NEW.product_id IS DISTINCT FROM wanted_product OR NEW.warehouse_id IS DISTINCT FROM wanted_warehouse OR
     NEW.on_hand_delta IS DISTINCT FROM hand OR NEW.reserved_delta IS DISTINCT FROM held OR hand IS NULL OR held IS NULL THEN
    RAISE EXCEPTION 'Ledger quantities or source do not match the business document' USING ERRCODE='23514';
  END IF;
  PERFORM check_precision(NEW.product_id,NEW.on_hand_delta);
  PERFORM check_precision(NEW.product_id,NEW.reserved_delta);
  INSERT INTO inventory_balances(warehouse_id,product_id) VALUES(NEW.warehouse_id,NEW.product_id) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT b FROM inventory_balances WHERE warehouse_id=NEW.warehouse_id AND product_id=NEW.product_id FOR UPDATE;
  NEW.on_hand_before:=b.on_hand; NEW.reserved_before:=b.reserved;
  NEW.on_hand_after:=b.on_hand+NEW.on_hand_delta; NEW.reserved_after:=b.reserved+NEW.reserved_delta;
  UPDATE inventory_balances SET on_hand=NEW.on_hand_after,reserved=NEW.reserved_after,
    version=version+1,updated_at=clock_timestamp() WHERE warehouse_id=NEW.warehouse_id AND product_id=NEW.product_id;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_apply BEFORE INSERT ON inventory_ledger FOR EACH ROW EXECUTE FUNCTION apply_ledger();

CREATE FUNCTION guard_header() RETURNS trigger LANGUAGE plpgsql
SET search_path = orderflow, pg_catalog AS $$
DECLARE allowed boolean := false;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN RAISE EXCEPTION 'New documents start as DRAFT' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Posted documents cannot be deleted' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (to_jsonb(NEW)-ARRAY['status','confirmed_at','fulfilled_at','cancelled_at','posted_at','sent_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','confirmed_at','fulfilled_at','cancelled_at','posted_at','sent_at']) THEN
    RAISE EXCEPTION 'Posted document facts cannot change' USING ERRCODE='23514';
  END IF;
  IF NEW.status=OLD.status THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='orders' THEN
    allowed := (OLD.status='DRAFT' AND NEW.status IN ('CONFIRMED','CANCELLED')) OR
               (OLD.status='CONFIRMED' AND NEW.status IN ('FULFILLED','CANCELLED'));
  ELSIF TG_TABLE_NAME IN ('receipts','order_returns') THEN
    allowed := OLD.status='DRAFT' AND NEW.status='POSTED';
  ELSIF TG_TABLE_NAME='transfers' THEN
    allowed := (OLD.status='DRAFT' AND NEW.status IN ('SENT','CANCELLED')) OR
      (OLD.status IN ('SENT','PARTIALLY_RECEIVED','DISPUTED') AND NEW.status IN ('PARTIALLY_RECEIVED','DISPUTED','RECEIVED','RESOLVED'));
    IF NEW.status IN ('RECEIVED','RESOLVED') AND (
      EXISTS (SELECT 1 FROM transfer_item_balances WHERE transfer_id=NEW.id AND (in_transit_qty<>0 OR quarantined_qty<>0)) OR
      EXISTS (SELECT 1 FROM discrepancy_status d JOIN transfer_items i ON i.id=d.transfer_item_id
        WHERE i.transfer_id=NEW.id AND d.outstanding_qty<>0)) THEN
      RAISE EXCEPTION 'Transfer still has unresolved quantities' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NOT allowed THEN RAISE EXCEPTION 'Invalid document transition: % to %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['orders','receipts','order_returns','transfers'] LOOP
    EXECUTE format('CREATE TRIGGER header_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_header()',t);
  END LOOP;
END $$;

CREATE FUNCTION guard_transfer_receipt_item() RETURNS trigger LANGUAGE plpgsql
SET search_path=orderflow,pg_catalog AS $$
DECLARE i transfer_items%ROWTYPE; remaining numeric; s text;
BEGIN
  SELECT * INTO STRICT i FROM transfer_items WHERE id=NEW.transfer_item_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM inventory_events WHERE transfer_receipt_id=NEW.receipt_id) THEN
    RAISE EXCEPTION 'A posted transfer receipt cannot gain new lines' USING ERRCODE='23514';
  END IF;
  SELECT status INTO s FROM transfers WHERE id=i.transfer_id;
  IF s NOT IN ('SENT','PARTIALLY_RECEIVED','DISPUTED') THEN RAISE EXCEPTION 'Transfer is not open for receiving' USING ERRCODE='23514'; END IF;
  SELECT in_transit_qty INTO remaining FROM transfer_item_balances WHERE transfer_item_id=i.id;
  IF NEW.accepted_qty > remaining THEN RAISE EXCEPTION 'Accepted quantity exceeds remaining transit; record excess as quarantined' USING ERRCODE='23514'; END IF;
  PERFORM check_precision(i.product_id,NEW.counted_qty);
  PERFORM check_precision(i.product_id,NEW.accepted_qty);
  PERFORM check_precision(i.product_id,NEW.quarantined_qty);
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_quantity BEFORE INSERT ON transfer_receipt_items FOR EACH ROW EXECUTE FUNCTION guard_transfer_receipt_item();

CREATE FUNCTION guard_discrepancy() RETURNS trigger LANGUAGE plpgsql
SET search_path=orderflow,pg_catalog AS $$
DECLARE b record; reported numeric;
BEGIN
  PERFORM assert_actor(NEW.reported_by);
  PERFORM 1 FROM transfer_items WHERE id=NEW.transfer_item_id FOR UPDATE;
  SELECT * INTO STRICT b FROM transfer_item_balances WHERE transfer_item_id=NEW.transfer_item_id;
  SELECT coalesce(sum(outstanding_qty),0) INTO reported FROM discrepancy_status
    WHERE transfer_item_id=NEW.transfer_item_id AND kind=NEW.kind;
  IF NEW.reported_qty+reported > (CASE WHEN NEW.kind='SHORTAGE' THEN b.in_transit_qty ELSE b.quarantined_qty END) THEN
    RAISE EXCEPTION 'Reported discrepancy exceeds unaccounted quantity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER discrepancy_quantity BEFORE INSERT ON transfer_discrepancies FOR EACH ROW EXECUTE FUNCTION guard_discrepancy();

CREATE FUNCTION guard_resolution() RETURNS trigger LANGUAGE plpgsql
SET search_path=orderflow,pg_catalog AS $$
DECLARE d record; b record; ri record; used numeric;
BEGIN
  PERFORM assert_actor(NEW.manager_id,true);
  SELECT * INTO STRICT d FROM transfer_discrepancies WHERE id=NEW.discrepancy_id;
  PERFORM 1 FROM transfer_items WHERE id=d.transfer_item_id FOR UPDATE;
  SELECT * INTO STRICT d FROM discrepancy_status WHERE id=NEW.discrepancy_id;
  IF NEW.quantity>d.outstanding_qty THEN RAISE EXCEPTION 'Resolution exceeds open discrepancy' USING ERRCODE='23514'; END IF;
  IF (d.kind='SHORTAGE' AND NEW.resolution_type NOT IN ('LOSS','DISPATCH_CORRECTION','LATER_RECEIPT')) OR
     (d.kind='EXCESS' AND NEW.resolution_type NOT IN ('ACCEPT_EXCESS','RETURN_EXCESS')) THEN
    RAISE EXCEPTION 'Resolution type does not match discrepancy kind' USING ERRCODE='23514';
  END IF;
  SELECT * INTO b FROM transfer_item_balances WHERE transfer_item_id=d.transfer_item_id;
  IF NEW.resolution_type IN ('LOSS','DISPATCH_CORRECTION') AND NEW.quantity>b.in_transit_qty THEN
    RAISE EXCEPTION 'Resolution exceeds in-transit quantity' USING ERRCODE='23514';
  END IF;
  IF NEW.resolution_type IN ('ACCEPT_EXCESS','RETURN_EXCESS') AND NEW.quantity>b.quarantined_qty THEN
    RAISE EXCEPTION 'Resolution exceeds quarantined quantity' USING ERRCODE='23514';
  END IF;
  IF NEW.resolution_type='LATER_RECEIPT' THEN
    SELECT * INTO STRICT ri FROM transfer_receipt_items WHERE id=NEW.later_receipt_item_id;
    SELECT coalesce(sum(quantity),0) INTO used FROM discrepancy_resolutions WHERE later_receipt_item_id=ri.id;
    IF ri.transfer_item_id<>d.transfer_item_id OR NEW.quantity+used>ri.accepted_qty OR
      (SELECT received_at FROM transfer_receipts WHERE id=ri.receipt_id)<d.created_at THEN
      RAISE EXCEPTION 'Later receipt does not cover this resolution' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resolution_quantity BEFORE INSERT ON discrepancy_resolutions FOR EACH ROW EXECUTE FUNCTION guard_resolution();

CREATE FUNCTION guard_stock_decision() RETURNS trigger LANGUAGE plpgsql
SET search_path=orderflow,pg_catalog AS $$
DECLARE r stock_change_requests%ROWTYPE; b inventory_balances%ROWTYPE;
BEGIN
  PERFORM assert_actor(NEW.manager_id,true);
  SELECT * INTO STRICT r FROM stock_change_requests WHERE id=NEW.request_id FOR UPDATE;
  IF NEW.decision='APPROVED' AND r.request_type<>'REVERSAL' THEN
    SELECT * INTO STRICT b FROM inventory_balances WHERE product_id=r.product_id AND warehouse_id=r.warehouse_id FOR UPDATE;
    IF NEW.reviewed_balance_version IS DISTINCT FROM b.version THEN
      RAISE EXCEPTION 'Review the current stock balance before approving' USING ERRCODE='23514';
    END IF;
    IF (r.request_type='COUNT' AND NEW.approved_delta IS DISTINCT FROM r.counted_qty-b.on_hand) OR
       (r.request_type<>'COUNT' AND NEW.approved_delta IS DISTINCT FROM r.requested_delta) THEN
      RAISE EXCEPTION 'Approved delta does not match the reviewed request' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_decision BEFORE INSERT ON stock_change_decisions FOR EACH ROW EXECUTE FUNCTION guard_stock_decision();

CREATE FUNCTION check_event_complete() RETURNS trigger LANGUAGE plpgsql
SET search_path=orderflow,pg_catalog AS $$
DECLARE e inventory_events%ROWTYPE; expected integer; actual integer; src record;
BEGIN
  SELECT * INTO STRICT e FROM inventory_events WHERE id=NEW.id;
  PERFORM assert_actor(e.actor_id);
  SELECT count(*) INTO actual FROM inventory_ledger WHERE event_id=e.id;
  IF e.event_type IN ('ORDER_CONFIRM','ORDER_CANCEL','ORDER_FULFILL') THEN
    IF NOT EXISTS (SELECT 1 FROM orders WHERE id=e.order_id AND
      ((e.event_type='ORDER_CONFIRM' AND status IN ('CONFIRMED','FULFILLED','CANCELLED')) OR
       (e.event_type='ORDER_CANCEL' AND status='CANCELLED') OR
       (e.event_type='ORDER_FULFILL' AND status='FULFILLED'))) THEN
      RAISE EXCEPTION 'Order status does not match its event' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO expected FROM order_items WHERE order_id=e.order_id;
    IF e.event_type<>'ORDER_CONFIRM' AND NOT EXISTS (SELECT 1 FROM inventory_events WHERE order_id=e.order_id AND event_type='ORDER_CONFIRM') THEN
      RAISE EXCEPTION 'Order must be confirmed before fulfilment or reservation release' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM inventory_events WHERE order_id=e.order_id AND event_type='ORDER_CANCEL') AND
       EXISTS (SELECT 1 FROM inventory_events WHERE order_id=e.order_id AND event_type='ORDER_FULFILL') THEN
      RAISE EXCEPTION 'An order cannot be both fulfilled and cancelled' USING ERRCODE='23514';
    END IF;
  ELSIF e.event_type IN ('OPENING','RECEIPT') THEN
    IF NOT EXISTS(SELECT 1 FROM receipts WHERE id=e.receipt_id AND status='POSTED') THEN RAISE EXCEPTION 'Receipt must be posted' USING ERRCODE='23514'; END IF;
    SELECT count(*) INTO expected FROM receipt_items WHERE receipt_id=e.receipt_id;
  ELSIF e.event_type='ORDER_RETURN' THEN
    IF NOT EXISTS(SELECT 1 FROM order_returns WHERE id=e.order_return_id AND status='POSTED') THEN RAISE EXCEPTION 'Return must be posted' USING ERRCODE='23514'; END IF;
    SELECT count(*) INTO expected FROM order_return_items WHERE return_id=e.order_return_id;
  ELSIF e.event_type='TRANSFER_SEND' THEN
    IF NOT EXISTS(SELECT 1 FROM transfers WHERE id=e.transfer_id AND status NOT IN ('DRAFT','CANCELLED')) THEN RAISE EXCEPTION 'Transfer must be sent' USING ERRCODE='23514'; END IF;
    SELECT count(*) INTO expected FROM transfer_items WHERE transfer_id=e.transfer_id AND sent_qty>0;
  ELSIF e.event_type='TRANSFER_RECEIVE' THEN
    SELECT count(*) INTO expected FROM transfer_receipt_items WHERE receipt_id=e.transfer_receipt_id AND accepted_qty>0;
  ELSIF e.event_type='TRANSFER_RESOLUTION' THEN
    PERFORM assert_actor(e.actor_id,true);
    SELECT CASE WHEN resolution_type IN ('ACCEPT_EXCESS','DISPATCH_CORRECTION') THEN 1 ELSE 0 END
      INTO expected FROM discrepancy_resolutions WHERE id=e.resolution_id;
  ELSIF e.event_type IN ('ADJUSTMENT','REVERSAL') THEN
    PERFORM assert_actor(e.actor_id,true);
    SELECT d.*,r.original_event_id,r.request_type INTO STRICT src FROM stock_change_decisions d
      JOIN stock_change_requests r ON r.id=d.request_id WHERE d.id=e.decision_id;
    IF src.decision<>'APPROVED' OR (e.event_type='REVERSAL' AND src.original_event_id IS DISTINCT FROM e.reversal_of_event_id) THEN
      RAISE EXCEPTION 'An approved matching decision is required' USING ERRCODE='23514';
    END IF;
    IF e.event_type='REVERSAL' THEN
      -- Full reversal is limited to receipt/adjustment events. Orders/transfers have their own stateful correction workflows.
      IF NOT EXISTS (SELECT 1 FROM inventory_events WHERE id=e.reversal_of_event_id AND event_type IN ('OPENING','RECEIPT','ADJUSTMENT')) THEN
        RAISE EXCEPTION 'Use the order or transfer correction workflow for this event' USING ERRCODE='23514';
      END IF;
      SELECT count(*) INTO expected FROM (SELECT product_id,warehouse_id FROM inventory_ledger WHERE event_id=e.reversal_of_event_id GROUP BY 1,2) pairs;
    ELSE expected:=CASE WHEN src.approved_delta=0 THEN 0 ELSE 1 END;
    END IF;
  END IF;
  IF expected IS NULL OR actual<>expected OR (expected=0 AND e.event_type NOT IN ('TRANSFER_RECEIVE','TRANSFER_RESOLUTION','ADJUSTMENT')) THEN
    RAISE EXCEPTION 'Inventory event % is incomplete: expected % ledger rows, found %',e.id,expected,actual USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER complete_event AFTER INSERT ON inventory_events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_event_complete();

CREATE FUNCTION check_document_event() RETURNS trigger LANGUAGE plpgsql
SET search_path=orderflow,pg_catalog AS $$
DECLARE found_event boolean := true;
BEGIN
  IF TG_TABLE_NAME='orders' THEN
    IF NEW.status='CONFIRMED' THEN
      SELECT EXISTS(SELECT 1 FROM inventory_events WHERE order_id=NEW.id AND event_type='ORDER_CONFIRM') INTO found_event;
    ELSIF NEW.status='FULFILLED' THEN
      SELECT EXISTS(SELECT 1 FROM inventory_events WHERE order_id=NEW.id AND event_type='ORDER_FULFILL') INTO found_event;
    ELSIF NEW.status='CANCELLED' AND OLD.status='CONFIRMED' THEN
      SELECT EXISTS(SELECT 1 FROM inventory_events WHERE order_id=NEW.id AND event_type='ORDER_CANCEL') INTO found_event;
    END IF;
  ELSIF TG_TABLE_NAME='receipts' AND (to_jsonb(NEW)->>'status')='POSTED' THEN
    SELECT EXISTS(SELECT 1 FROM inventory_events WHERE receipt_id=NEW.id) INTO found_event;
  ELSIF TG_TABLE_NAME='order_returns' AND (to_jsonb(NEW)->>'status')='POSTED' THEN
    SELECT EXISTS(SELECT 1 FROM inventory_events WHERE order_return_id=NEW.id) INTO found_event;
  ELSIF TG_TABLE_NAME='transfers' AND (to_jsonb(NEW)->>'status')='SENT' THEN
    SELECT EXISTS(SELECT 1 FROM inventory_events WHERE transfer_id=NEW.id) INTO found_event;
  ELSIF TG_TABLE_NAME='transfer_receipts' THEN
    SELECT EXISTS(SELECT 1 FROM inventory_events WHERE transfer_receipt_id=NEW.id) INTO found_event;
  ELSIF TG_TABLE_NAME='discrepancy_resolutions' AND (to_jsonb(NEW)->>'resolution_type') IN ('DISPATCH_CORRECTION','ACCEPT_EXCESS') THEN
    SELECT EXISTS(SELECT 1 FROM inventory_events WHERE resolution_id=NEW.id) INTO found_event;
  ELSIF TG_TABLE_NAME='stock_change_decisions' AND (to_jsonb(NEW)->>'decision')='APPROVED' THEN
    SELECT EXISTS(SELECT 1 FROM inventory_events WHERE decision_id=NEW.id) INTO found_event;
  END IF;
  IF NOT found_event THEN RAISE EXCEPTION 'Stock-changing document requires its inventory event in the same transaction' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['orders','receipts','order_returns','transfers'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER document_event AFTER UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_document_event()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['transfer_receipts','discrepancy_resolutions','stock_change_decisions'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER document_event AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_document_event()',t);
  END LOOP;
END $$;

CREATE FUNCTION event_audit() RETURNS trigger LANGUAGE plpgsql
SET search_path=orderflow,pg_catalog AS $$
BEGIN
  PERFORM assert_actor(NEW.actor_id);
  INSERT INTO audit_events(actor_id,action,entity_type,entity_id,details)
    VALUES(NEW.actor_id,NEW.event_type,'inventory_event',NEW.id::text,jsonb_build_object('correlation_id',NEW.correlation_id));
  RETURN NEW;
END $$;
CREATE TRIGGER event_audit_record AFTER INSERT ON inventory_events FOR EACH ROW EXECUTE FUNCTION event_audit();
