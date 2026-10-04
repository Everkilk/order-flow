type NotificationText = { eventClass: string; title: string; body: string };

// Read-side metadata also localizes historical notifications without changing their text.
// Only known system templates are parsed; captured identifiers/names remain data.
export function notificationMessage(row: NotificationText) {
  const titleMatch=row.eventClass==='LOW_STOCK' ? /^Low stock: ([\s\S]+)$/.exec(row.title) : null;
  let messageKey=row.body;
  let messageValues:Record<string,string>={};
  const rules:[string,RegExp,string,string[]][]=[
    ['LOW_STOCK',/^(-?\d+(?:\.\d+)?) available in ([\s\S]+)\.$/,'{amount} available in {warehouse}.',['amount','warehouse']],
    ['ORDER_ASSIGNED',/^Order ([\s\S]+) is assigned to you\.$/,'Order {document} is assigned to you.',['document']],
    ['ORDER_READY',/^Order ([\s\S]+) is (confirmed)\.$/,'Order {document} is {status}.',['document','status']],
    ['ORDER_CANCELLED',/^Order ([\s\S]+) is (cancelled)\.$/,'Order {document} is {status}.',['document','status']],
    ['TRANSFER_RECEIVE',/^Transfer ([\s\S]+) is ready to receive\.$/,'Transfer {document} is ready to receive.',['document']],
    ['TRANSFER_PROGRESS',/^Transfer #(\d+) is now (sent|partially_received|disputed|received|resolved)\.$/,'Transfer #{id} is now {status}.',['id','status']],
    ['TRANSFER_DISCREPANCY',/^Transfer #(\d+) has quarantined excess stock\.$/,'Transfer #{id} has quarantined excess stock.',['id']],
    ['TRANSFER_DISCREPANCY',/^Transfer #(\d+) has a reported shortage\.$/,'Transfer #{id} has a reported shortage.',['id']],
    ['STOCK_APPROVAL',/^(DAMAGE|LOSS|COUNT|REVERSAL) request #(\d+) is ready for review\.$/,'{type} request #{id} is ready for review.',['type','id']],
    ['APPROVAL_DECISION',/^Stock request #(\d+) was (approved|rejected)\.$/,'Stock request #{id} was {status}.',['id','status']],
    ['IMPORT_COMPLETE',/^Imported (\d+) rows\.$/,'Imported {count} rows.',['count']],
  ];
  for(const [event,pattern,key,fields] of rules) {
    if(event!==row.eventClass) continue;
    const match=pattern.exec(row.body);
    if(!match) continue;
    messageKey=key;messageValues=Object.fromEntries(fields.map((field,index)=>[field,match[index+1]!]));break;
  }
  return {titleKey:titleMatch?'Low stock: {sku}':row.title,titleValues:titleMatch?{sku:titleMatch[1]}:{},messageKey,messageValues};
}
