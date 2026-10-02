import { Decimal } from 'decimal.js';

export const version='DEMO-V2';
export const limits={requests:1000,jobs:8,fileBytes:256*1024,totalFileBytes:2*1024*1024,durationMs:60*60*1000};
export const accounts=[
  {key:'staff',email:'staff@example.com',displayName:'Demo Staff / Nhân viên mẫu',role:'STAFF',warehouses:[0,1,2],passwordEnv:'DEMO_STAFF_PASSWORD'},
  {key:'north',email:'staff.north@example.com',displayName:'North Staff / Nhân viên miền Bắc',role:'STAFF',warehouses:[1],passwordEnv:'DEMO_NORTH_PASSWORD'},
  {key:'viewer',email:'viewer@example.com',displayName:'Demo Viewer / Người xem mẫu',role:'VIEWER',warehouses:[0,1,2],passwordEnv:'DEMO_VIEWER_PASSWORD'},
];
export const warehouses=[
  {code:`${version}-MAIN`,name:'Main Warehouse / Kho chính'},
  {code:`${version}-NORTH`,name:'North Branch / Chi nhánh miền Bắc'},
  {code:`${version}-SOUTH`,name:'South Branch / Chi nhánh miền Nam'},
];
export const units=[
  ['PC','Piece / Cái',0],['PAIR','Pair / Đôi',0],['SET','Set / Bộ',0],['BOX','Box / Hộp',0],
  ['M','Metre / Mét',6],['KG','Kilogram / Kilôgam',6],['L','Litre / Lít',6],
].map(([key,name,decimalPlaces])=>({key,code:`${version}-${key}`,name,decimalPlaces}));
const industries=[
  ['Electronics / Điện tử',[
    'Smartphone / Điện thoại thông minh','Tablet / Máy tính bảng','Laptop / Máy tính xách tay','Monitor / Màn hình',
    'Keyboard / Bàn phím','Mouse / Chuột','USB charger / Bộ sạc USB','Power bank / Pin dự phòng','Headphones / Tai nghe','Portable speaker / Loa di động']],
  ['Apparel / Thời trang',[
    'Blue T-shirt / Áo thun xanh','Red T-shirt / Áo thun đỏ','Cotton shirt / Áo sơ mi cotton','Denim trousers / Quần jeans',
    'Running shoes / Giày chạy bộ','Sandals / Dép','Socks / Tất','Cap / Mũ','Backpack / Ba lô','Canvas fabric / Vải canvas']],
  ['Food & beverages / Thực phẩm và đồ uống',[
    'Rice / Gạo','Milk / Sữa','Coffee beans / Cà phê hạt','Green tea / Trà xanh','Biscuits / Bánh quy','Fruit juice / Nước ép trái cây',
    'Cooking oil / Dầu ăn','Pasta / Mì ý','Chocolate / Sô cô la','Oat cereal / Ngũ cốc yến mạch']],
  ['Hardware & construction / Dụng cụ và xây dựng',[
    'Cordless drill / Máy khoan pin','Hammer / Búa','Screwdriver set / Bộ tua vít','Safety gloves / Găng tay bảo hộ',
    'Screw box / Hộp vít','Timber beam / Thanh gỗ','Steel cable / Cáp thép','Wall paint / Sơn tường','Cement / Xi măng','Measuring tape / Thước cuộn']],
  ['Beauty & household / Mỹ phẩm và gia dụng',[
    'Shampoo / Dầu gội','Hand soap / Xà phòng rửa tay','Face cream / Kem dưỡng da','Laundry liquid / Nước giặt','Dishwashing liquid / Nước rửa chén',
    'Bath towel / Khăn tắm','Toothbrush set / Bộ bàn chải','Water bottle / Bình nước','Storage container / Hộp đựng','Cleaning cloth / Khăn lau']],
  ['Stationery & office / Văn phòng phẩm',[
    'Notebook / Sổ tay','Ballpoint pen box / Hộp bút bi','Printer paper box / Hộp giấy in','Stapler / Dập ghim','Marker set / Bộ bút dạ',
    'Adhesive tape / Băng dính','File folder / Bìa hồ sơ','Desk organizer / Khay bàn làm việc','Scissors / Kéo','Drawing paper / Giấy vẽ']],
];
export const categories=industries.map(([name])=>({name:`${version} · ${name}`}));
export const attributes=[
  {key:'colour',label:'Colour / Màu',dataType:'string',required:false},
  {key:'size',label:'Size / Kích cỡ',dataType:'number',required:false,minValue:0},
  {key:'material',label:'Material / Chất liệu',dataType:'string',required:false},
  {key:'capacity',label:'Capacity / Dung tích',dataType:'number',required:false,minValue:0},
];
export const suppliers=industries.map((_,i)=>({name:`${version} · Sample supplier ${i+1} / Nhà cung cấp mẫu ${i+1}`,email:`supplier${i+1}@example.invalid`}));
const unitFor=new Map([[14,'PAIR'],[15,'PAIR'],[16,'PAIR'],[19,'M'],[20,'KG'],[21,'L'],[22,'KG'],[25,'L'],[26,'L'],[32,'SET'],[33,'PAIR'],[34,'BOX'],[35,'M'],[36,'M'],[37,'L'],[38,'KG'],[40,'L'],[41,'L'],[43,'L'],[44,'L'],[46,'SET'],[51,'BOX'],[52,'BOX'],[54,'SET'],[55,'M'],[59,'M']]);
export const products=industries.flatMap(([,names],category)=>names.map((name,index)=>{
  const n=category*10+index;
  return {index:n,sku:`${version}-P${String(n+1).padStart(3,'0')}`,barcode:`${version}-BAR${String(n+1).padStart(3,'0')}`,
    name,category,unit:unitFor.get(n) ?? 'PC',sellingPrice:index%2?'250000':'25',sellingCurrency:index%2?'VND':'USD',
    cost:index%2?'150000':'10',currency:index%2?'VND':'USD',supplier:category,unvalued:n>=58,
    description:'Fictional shared demo item / Mặt hàng mẫu dùng chung, không phải hàng thật.',
    attributes:{colour:['Blue / Xanh','Red / Đỏ','White / Trắng'][index%3],size:index+1,material:category===1?'Cotton / Cotton':'Demo material / Vật liệu mẫu',capacity:100*(index+1)},
  };
}));
const actor=warehouse=>warehouse===1?'north':'staff';
export const opening=warehouses.map((_,warehouse)=>({number:`${version}-OPEN-${warehouse+1}`,warehouse,actor:'admin',
  items:products.map(p=>({product:p.index,quantity:warehouse===0 && p.index<6?'2':warehouse===0 && p.index>=14 && p.index<16?'10':warehouse===0 && p.index>=16 && p.index<20?'2':units.find(u=>u.key===p.unit).decimalPlaces?'30.625':'30'}))}));
export const receipts=Array.from({length:9},(_,i)=>({number:`${version}-REC-${String(i+1).padStart(2,'0')}`,warehouse:i%3,actor:actor(i%3),status:i<6?'POSTED':'DRAFT',supplier:i%6,
  items:[{product:20+i,quantity:'5'},{product:40+i,quantity:'3'}]}));
export const orders=Array.from({length:24},(_,i)=>{
  const status=i<6?'DRAFT':i<12?'CONFIRMED':i<20?'FULFILLED':'CANCELLED';
  const warehouse=i>=12 && i<18?0:i===18?1:i===19?2:i%3;
  const product=i>=12 && i<18?i-12:i===18?6:i===19?7:i>=6 && i<9?i+2:i+2;
  const qty=i>=6 && i<9?'30':i>=12 && i<18?'2':i>=18 && i<20?'6':'3';
  return {number:`${version}-ORD-${String(i+1).padStart(2,'0')}`,warehouse,actor:actor(warehouse),status,
    // Three confirmed documents reserve the whole Main balance of three distinct products.
    items:[{product,quantity:qty,warehouse:i>=6 && i<9?0:warehouse}]};
});
// Fully reserved orders are owned by main Staff, who has their Main warehouse access.
for(let i=6;i<9;i++) {orders[i].warehouse=0;orders[i].actor='staff';}
for(let i=0;i<6;i++) orders[i].actor='staff';
export const returns=Array.from({length:6},(_,i)=>({number:`${version}-RET-${i+1}`,order:18+i%2,
  warehouse:i%2?2:1,actor:i%2?'staff':'north',status:i<3?'POSTED':'DRAFT',quantity:'1'}));
export const transfers=Array.from({length:12},(_,i)=>({number:`${version}-TRF-${String(i+1).padStart(2,'0')}`,
  source:i%2?1:0,destination:i%2?0:1,actor:i%2?'north':'staff',receiver:i%2?'staff':'north',product:32+i,quantity:'4',
  scenario:['DRAFT','DRAFT','SENT','SENT','PARTIALLY_RECEIVED','PARTIALLY_RECEIVED','SHORTAGE','EXCESS','RECEIVED','RECEIVED','LOSS','ACCEPT_EXCESS'][i],
  status:['DRAFT','DRAFT','SENT','SENT','PARTIALLY_RECEIVED','PARTIALLY_RECEIVED','DISPUTED','DISPUTED','RECEIVED','RECEIVED','RESOLVED','RESOLVED'][i]}));
export const requests=Array.from({length:6},(_,i)=>({key:`${version}-REQ-${i+1}`,product:14+i,warehouse:i%2?1:0,actor:i%2?'north':'staff',
  requestType:i<2?'COUNT':i<4?'DAMAGE':'LOSS',quantity:i>=2 && i<4?'9':'1',decision:i<2?null:i<4?'APPROVED':'REJECTED'}));
// Approved changes create low-stock crossings on Main products 15 and 16.
requests[2].product=14;requests[2].warehouse=0;requests[2].actor='staff';
requests[3].product=15;requests[3].warehouse=0;requests[3].actor='staff';
export const thresholds=Array.from({length:6},(_,i)=>({warehouse:0,product:14+i,threshold:'5',criticalThreshold:'1'}));

export function expectedBalances() {
  const balances=new Map();
  const change=(warehouse,product,onHand,reserved='0')=>{
    const key=`${warehouse}:${product}`,old=balances.get(key) ?? {onHand:new Decimal(0),reserved:new Decimal(0)};
    old.onHand=old.onHand.plus(onHand);old.reserved=old.reserved.plus(reserved);balances.set(key,old);
  };
  for(const doc of opening) for(const line of doc.items) change(doc.warehouse,line.product,line.quantity);
  for(const doc of receipts.filter(r=>r.status==='POSTED')) for(const line of doc.items) change(doc.warehouse,line.product,line.quantity);
  for(const doc of orders) for(const line of doc.items) {
    if(doc.status==='CONFIRMED') change(line.warehouse,line.product,'0',line.quantity);
    if(doc.status==='FULFILLED') change(line.warehouse,line.product,new Decimal(line.quantity).negated());
  }
  for(const doc of returns.filter(r=>r.status==='POSTED')) change(doc.warehouse,orders[doc.order].items[0].product,doc.quantity);
  for(const doc of transfers) {
    if(doc.scenario==='DRAFT') continue;
    change(doc.source,doc.product,'-4');
    if(doc.scenario==='PARTIALLY_RECEIVED') change(doc.destination,doc.product,'2');
    if(['SHORTAGE','LOSS'].includes(doc.scenario)) change(doc.destination,doc.product,'3');
    if(['EXCESS','RECEIVED'].includes(doc.scenario)) change(doc.destination,doc.product,'4');
    if(doc.scenario==='ACCEPT_EXCESS') change(doc.destination,doc.product,'5');
  }
  for(const request of requests.filter(r=>r.decision==='APPROVED')) change(request.warehouse,request.product,new Decimal(request.quantity).negated());
  return [...balances].map(([key,row])=>({key,onHand:row.onHand.toFixed(6),reserved:row.reserved.toFixed(6),available:row.onHand.minus(row.reserved).toFixed(6)}));
}

export function datasetSummary() {
  const balances=expectedBalances();
  return {version,products:products.length,categories:categories.length,warehouses:warehouses.length,suppliers:suppliers.length,
    receipts:opening.length+receipts.length,orders:orders.length,returns:returns.length,transfers:transfers.length,requests:requests.length,
    stockRows:balances.length,zeroOnHand:balances.filter(b=>new Decimal(b.onHand).isZero()).length,
    fullyReserved:balances.filter(b=>new Decimal(b.onHand).gt(0) && new Decimal(b.available).isZero()).length,
    lowStock:thresholds.filter(t=>new Decimal(balances.find(b=>b.key===`${t.warehouse}:${t.product}`).available).gt(0) && new Decimal(balances.find(b=>b.key===`${t.warehouse}:${t.product}`).available).lt(t.threshold)).length,
    limits};
}
