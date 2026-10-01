import { randomUUID } from 'node:crypto';

export async function createExample(client, prefix = `demo_${randomUUID().slice(0,8)}`, post = true) {
  const id = async (sql, values) => (await client.query(sql, values)).rows[0].id;
  const manager = await id(`INSERT INTO orderflow.users(email,display_name,password_hash,role)
    VALUES($1,'Example manager','DEMO_ONLY_NO_LOGIN','MANAGER') RETURNING id`, [`${prefix}@example.invalid`]);
  const unit = await id(`INSERT INTO orderflow.units(code,name,decimal_places) VALUES($1,'Piece',0) RETURNING id`, [prefix]);
  const category = await id('INSERT INTO orderflow.categories(name) VALUES($1) RETURNING id', [`Phones ${prefix}`]);
  await client.query(`INSERT INTO orderflow.category_attributes(category_id,key,label,data_type,required,unit_label,min_value)
    VALUES($1,'screen_size_inches','Screen size','number',true,'inches',0.1)`, [category]);
  await client.query(`INSERT INTO orderflow.category_attributes(category_id,key,label,data_type,required)
    VALUES($1,'color','Color','string',false)`, [category]);
  const product = await id(`INSERT INTO orderflow.products(sku,name,category_id,unit_id,attributes)
    VALUES($1,'Example phone',$2,$3,$4) RETURNING id`, [prefix,category,unit,{screen_size_inches:6.1,color:'silver'}]);
  const warehouse = await id('INSERT INTO orderflow.warehouses(code,name) VALUES($1,$2) RETURNING id', [prefix,`Main warehouse ${prefix}`]);
  const receipt = await id(`INSERT INTO orderflow.receipts(receipt_number,kind,warehouse_id,created_by,note)
    VALUES($1,'OPENING',$2,$3,'Example starting stock') RETURNING id`, [prefix,warehouse,manager]);
  await client.query('INSERT INTO orderflow.receipt_items(receipt_id,product_id,quantity) VALUES($1,$2,10)',[receipt,product]);
  if (post) await client.query('SELECT orderflow.post_receipt($1,$2,$3)',[receipt,manager,randomUUID()]);
  return { manager, unit, category, product, warehouse, receipt, prefix };
}

export async function createOrder(client, example, quantity, product = example.product) {
  const result = await client.query(`INSERT INTO orderflow.orders(order_number,created_by)
    VALUES($1,$2) RETURNING id`, [`example-${randomUUID()}`,example.manager]);
  const order = result.rows[0].id;
  await client.query(`INSERT INTO orderflow.order_items(order_id,product_id,warehouse_id,quantity)
    VALUES($1,$2,$3,$4)`,[order,product,example.warehouse,quantity]);
  return order;
}
