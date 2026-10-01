-- Stock workflows now run in the TypeScript backend. Remove obsolete SQL commands
-- so they cannot write incomplete ledger rows after the backend balance cutover.
SET LOCAL search_path = orderflow, pg_catalog;

DROP FUNCTION confirm_order(bigint,bigint,uuid);
DROP FUNCTION cancel_order(bigint,bigint,uuid);
DROP FUNCTION fulfill_order(bigint,bigint,uuid);
DROP FUNCTION change_order(bigint,bigint,uuid,text);
DROP FUNCTION post_receipt(bigint,bigint,uuid);
DROP FUNCTION post_order_return(bigint,bigint,uuid);
DROP FUNCTION send_transfer(bigint,bigint,uuid);
DROP FUNCTION command_retry(uuid,text,bigint,bigint);

COMMENT ON TABLE inventory_balances IS 'Accepted warehouse stock only. Updated with inventory_ledger by the backend in one transaction.';
COMMENT ON TABLE inventory_ledger IS 'Append-only warehouse stock history; before and after values are written by the backend.';
