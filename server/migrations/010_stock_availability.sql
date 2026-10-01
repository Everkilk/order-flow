SET LOCAL search_path = orderflow, pg_catalog;

-- Keep sparse out-of-stock pages fast as the balance table grows.
CREATE INDEX inventory_balances_out_of_stock_idx
  ON inventory_balances(warehouse_id, product_id) WHERE available = 0;
