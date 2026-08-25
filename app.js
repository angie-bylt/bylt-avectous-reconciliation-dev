/* ===========================================================
   FULFILLMENT WIDGET — top-of-dashboard rollup, separate from the
   per-area SECTIONS below. Cross-references NetSuite's "fulfillable
   orders" list against two other data sources (NetSuite's already-
   fulfilled search, Avectous's shipped-orders export) to show overall
   warehouse progress, not an integration-accuracy check.
=========================================================== */
const FULFILLMENT_WIDGET = {
  title:'Sales Orders & Transfer Orders Fulfillment Status',
  fulfillableOrdersUrl:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?searchid=4854&saverun=T&whence=',
  fulfillable:{
    dateField:'Date',
    typeField:'Type',
    orderNumberField:'PO/Check Number',
    wmsStatusField:'WMS Status',
    wmsStatusRequiredValue:'Pending Fulfillment',
    soTypeValue:'Sales Order',
    toTypeValue:'Transfer Order'
  },
  // NetSuite's own already-fulfilled search (same one SO/TO Fulfillments use)
  nsFulfilled:{
    orderNumberField:['Order Number','Name','OrderNumber']
  },
  // Avectous's shipped-orders export, filtered by order type per SO/TO
  avShipped:{
    orderNumberField:'OrderNumber',
    typeFilterField:'OrderType',
    soTypeFilterValue:'SHPY',
    toTypeFilterValue:'TOS'
  }
};

function computeFulfillmentWidget(fulfillableData, nsFulfilledData, avShippedData, dateFrom, dateTo){
  const cfg = FULFILLMENT_WIDGET.fulfillable;
  const dateCol = guessColumn(fulfillableData.headers, cfg.dateField);
  const typeCol = guessColumn(fulfillableData.headers, cfg.typeField);
  const orderCol = guessColumn(fulfillableData.headers, cfg.orderNumberField);
  const wmsCol = guessColumn(fulfillableData.headers, cfg.wmsStatusField);

  let rows = fulfillableData.rows.filter(r => norm(r[wmsCol]) === norm(cfg.wmsStatusRequiredValue));
  if(dateFrom || dateTo){
    rows = rows.filter(r=>{
      const raw = r[dateCol];
      const d = raw instanceof Date ? raw : new Date(raw);
      if(isNaN(d.getTime())) return true; // don't silently drop rows with unparseable dates
      if(dateFrom && d < new Date(dateFrom)) return false;
      if(dateTo && d > new Date(dateTo + 'T23:59:59')) return false;
      return true;
    });
  }

  const soRows = rows.filter(r => r[typeCol] === cfg.soTypeValue);
  const toRows = rows.filter(r => r[typeCol] === cfg.toTypeValue);

  function crossReference(rowsForType, orderColLocal, nsData, avData, avTypeValue){
    const orderNumbers = new Set(rowsForType.map(r => norm(r[orderColLocal])).filter(k => k && k !== norm('- None -')));
    let fulfilledInNs = null, fulfilledInAv = null;
    if(nsData && nsData.rows && nsData.rows.length){
      const nsOrderCol = guessColumn(nsData.headers, FULFILLMENT_WIDGET.nsFulfilled.orderNumberField);
      if(nsOrderCol){
        const nsKeys = new Set(nsData.rows.map(r => norm(r[nsOrderCol])));
        fulfilledInNs = [...orderNumbers].filter(k => nsKeys.has(k)).length;
      }
    }
    if(avData && avData.rows && avData.rows.length){
      const avCfg = FULFILLMENT_WIDGET.avShipped;
      const avOrderCol = guessColumn(avData.headers, avCfg.orderNumberField);
      const avTypeCol = guessColumn(avData.headers, avCfg.typeFilterField);
      if(avOrderCol){
        const filteredAvRows = avTypeCol ? avData.rows.filter(r => norm(r[avTypeCol]) === norm(avTypeValue)) : avData.rows;
        const avKeys = new Set(filteredAvRows.map(r => norm(r[avOrderCol])));
        fulfilledInAv = [...orderNumbers].filter(k => avKeys.has(k)).length;
      }
    }
    return { total: rowsForType.length, fulfilledInNs, fulfilledInAv };
  }

  const so = crossReference(soRows, orderCol, nsFulfilledData, avShippedData, FULFILLMENT_WIDGET.avShipped.soTypeFilterValue);
  const to = crossReference(toRows, orderCol, nsFulfilledData, avShippedData, FULFILLMENT_WIDGET.avShipped.toTypeFilterValue);

  return {
    totalFulfillable: rows.length,
    so, to
  };
}

/* ===========================================================
   SECTION DEFINITIONS — one entry per reconciliation area
=========================================================== */
const SECTIONS = [
  {
    id:'so', title:'Sales Orders',
    netsuiteUrl:'https://11170298.app.netsuite.com/app/common/search/searchresults.nl?searchid=4829&whence=',
    secondUrl:'https://bylt.avectous.com/portal/frameworkpage/62c9bee6-310c-46bf-4c3b-08deafb23cf9/542dc233-d6c6-4d03-bf52-cf5f252218b1/33d41bbb-b683-4fd1-b632-b4a3a9f83eb1',
    sub:'customsearch_avectous_allocated_orders_4 · NetSuite is source of truth',
    sourceOfTruth:'netsuite',
    collapseMissingToOrderLevel:true,
    keyFields:[
      {field:'orderNumber', label:'Order Number', ns:'OrderNumber', av:'OrderNumber', display:'half'},
      {field:'productId',   label:'Product Id',   ns:'ProductId',   av:'ProductId'}
    ],
    compareFields:[ {field:'qty', label:'Qty', ns:'Qty', av:'Qty', numeric:true} ]
  },
  {
    id:'to', title:'Outbound Transfer Orders',
    netsuiteUrl:'https://11170298.app.netsuite.com/app/common/search/searchresults.nl?searchid=4834&whence=',
    secondUrl:'https://bylt.avectous.com/portal/frameworkpage/62c9bee6-310c-46bf-4c3b-08deafb23cf9/542dc233-d6c6-4d03-bf52-cf5f252218b1/33d41bbb-b683-4fd1-b632-b4a3a9f83eb1',
    sub:'customsearch_avectous_outbound_to_deta_3 · NetSuite is source of truth',
    sourceOfTruth:'netsuite',
    collapseMissingToOrderLevel:true,
    keyFields:[
      {field:'orderNumber', label:'Order Number', ns:'OrderNumber', av:'OrderNumber', display:'bare'},
      {field:'line',         label:'Line',         ns:'Line',        av:'Line',        display:'bare'}
    ],
    compareFields:[
      {field:'productId',    label:'ProductId',    ns:'ProductId',        av:'ProductId'},
      {field:'quantity',     label:'Qty',           ns:['Qty','Quantity'], av:'Qty',       numeric:true}
    ]
  },
  {
    id:'sof', title:'SO Fulfillments / Ship Confirmations',
    netsuiteUrl:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?searchid=4830&saverun=T&whence=',
    secondUrl:'https://bylt.avectous.com/portal/frameworkpage/62c9bee6-310c-46bf-4c3b-08deafb23cf9/fd3d1b31-bfad-40cb-a741-b668c0775c06/6c62087f-86e1-4732-a5c7-351ffab723a6',
    sub:'customsearch4713 · Avectous is source of truth',
    sourceOfTruth:'avectous',
    supportsAuditLevelToggle:true,
    keyFields:[
      {field:'orderNumber', label:'Order Number', ns:'OrderNumber', av:'OrderNumber', display:'half'},
      {field:'productId',   label:'Product Id',   ns:'ProductId',   av:'ProductId'}
    ],
    compareFields:[ {field:'qty', label:'Qty', ns:'Qty', av:'Quantity', numeric:true} ],
    orderLevelVariant:{
      // Order-level audit for SO Fulfillments checks something different
      // from line-level: NetSuite's UNFULFILLED orders vs Avectous's
      // SHIPPED orders (filtered to Sales Orders only, since Avectous's
      // export mixes order types). An order appearing in BOTH lists means
      // Avectous already shipped it, but NetSuite hasn't caught up yet —
      // flagging the overlap, not the usual difference.
      netsuiteUrlOverride:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?searchid=4846&saverun=T&whence=',
      keyFields:[
        {field:'orderNumber', label:'Order Number', ns:'Order Number', av:'OrderNumber', display:'bare'}
      ],
      compareFields:[],
      flagMode:'intersection',
      flagLabelShort:'shipped, unfulfilled',
      missingLabelOverride:'Shipped in Avectous, Unfulfilled in NetSuite',
      avFilterField:'OrderType',
      avFilterValue:'SHPY'
    }
  },
  {
    id:'tof', title:'Outbound TO Fulfillments / Ship Confirmations',
    netsuiteUrl:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?searchid=4835&saverun=T&whence=',
    secondUrl:'https://bylt.avectous.com/portal/frameworkpage/62c9bee6-310c-46bf-4c3b-08deafb23cf9/fd3d1b31-bfad-40cb-a741-b668c0775c06/6c62087f-86e1-4732-a5c7-351ffab723a6',
    sub:'customsearch4712 · Avectous is source of truth',
    sourceOfTruth:'avectous',
    supportsAuditLevelToggle:true,
    keyFields:[
      {field:'orderNumber', label:'Order Number', ns:'OrderNumber', av:'OrderNumber', display:'half'},
      {field:'productId',   label:'Product Id',   ns:'ProductID',   av:'ProductId'}
    ],
    compareFields:[ {field:'qty', label:'Qty', ns:'Sum of Quantity', av:'Quantity', numeric:true} ],
    orderLevelVariant:{
      // Same logic as SO Fulfillments: NetSuite's UNFULFILLED transfer
      // orders vs Avectous's SHIPPED orders (filtered to Transfer Orders
      // only, since Avectous's export mixes order types). An order in
      // BOTH lists means Avectous already shipped it, but NetSuite hasn't
      // caught up — flagging the overlap, not the usual difference.
      netsuiteUrlOverride:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?searchid=4847&saverun=T&whence=',
      keyFields:[
        {field:'orderNumber', label:'Order Number', ns:'OrderNumber', av:'OrderNumber', display:'bare'}
      ],
      compareFields:[],
      flagMode:'intersection',
      flagLabelShort:'shipped, unfulfilled',
      missingLabelOverride:'Shipped in Avectous, Unfulfilled in NetSuite',
      avFilterField:'OrderType',
      avFilterValue:'TOS'
    }
  },
  {
    id:'ito', title:'Inbound TOs (800 → 810)',
    netsuiteUrl:'https://11170298.app.netsuite.com/app/common/search/searchresults.nl?searchid=4694&whence=',
    secondUrl:'https://bylt.avectous.com/portal/frameworkpage/62c9bee6-310c-46bf-4c3b-08deafb23cf9/945af7af-099b-474e-996a-3c17d5b07ade/49053eba-7d7d-48e8-ae86-e985c69382be',
    sub:'customsearch_avectous_inbound_to_detai_5 · NetSuite is source of truth',
    sourceOfTruth:'netsuite',
    keyFields:[
      {field:'erNo',      label:'ERNo',      ns:'ERNo',      av:'ERNo'},
      {field:'productId', label:'Product Id', ns:'ProductId', av:'ProductId'}
    ],
    compareFields:[ {field:'receivedQty', label:'Received Qty', ns:'ReceivedQty', av:'ReceivedQty', numeric:true} ]
  },
  {
    id:'is', title:'Inbound Shipments',
    netsuiteUrl:'https://11170298.app.netsuite.com/app/common/search/searchresults.nl?searchid=4688&whence=',
    secondUrl:'https://bylt.avectous.com/portal/frameworkpage/62c9bee6-310c-46bf-4c3b-08deafb23cf9/945af7af-099b-474e-996a-3c17d5b07ade/49053eba-7d7d-48e8-ae86-e985c69382be',
    sub:'customsearch_inbound_shipment_2 · NetSuite is source of truth',
    sourceOfTruth:'netsuite',
    keyFields:[
      {field:'erNo',      label:'Shipment Number (NS) / ERNo (AV)', ns:'Shipment Number', av:'ERNo'},
      {field:'productId', label:'Product Id',                       ns:'ProductId',        av:'ProductId'}
    ],
    compareFields:[ {field:'receivedQty', label:'Received Qty', ns:'ReceivedQty', av:'ReceivedQty', numeric:true} ]
  },
  {
    id:'inv', title:'Inventory Discrepancies',
    netsuiteUrl:'https://11170298.app.netsuite.com/app/common/search/searchresults.nl?searchid=4824&whence=',
    secondUrl:'https://bylt.avectous.com/portal/frameworkpage/62c9bee6-310c-46bf-4c3b-08deafb23cf9/0f82e76c-5aba-461d-9795-524dabae842d/1469b7b8-4b6f-47df-bd32-1a4a9242507a',
    sub:'customsearch4824 · Avectous is source of truth',
    sourceOfTruth:'avectous',
    firstStatLabel:'Total SKUs in Avectous',
    firstStatUsesAv:true,
    matchedStatLabel:'Matches',
    missingStatLabel:'Missing from NetSuite',
    analyzedCountLabel:'SKUs in Avectous',
    supplementaryFile:{
      label:'Open Receipts',
      url:'https://bylt.avectous.com/portal/frameworkpage/62c9bee6-310c-46bf-4c3b-08deafb23cf9/945af7af-099b-474e-996a-3c17d5b07ade/13bb18fd-8c4c-4e84-892a-736c3fa62afd',
      keyField:'ProductId',
      statusField:'ErStatus',
      openValue:'OPN'
    },
    keyFields:[ {field:'productId', label:'SKU', ns:['SKU','ProductId'], av:['SKU','ProductId']} ],
    compareFields:[
      {field:'totalQty', label:'Total Qty', ns:['NS On Hand','TotalQty'], av:['Avectous Total Qty','TotalQty'], numeric:true}
    ]
  },
  {
    id:'vesyl', title:'VESYL Shipments Audit',
    netsuiteUrl:'https://11170298.app.netsuite.com/app/common/search/searchresults.nl?searchid=4842&whence=',
    secondUrl:'https://app.vesyl.com/shipments',
    secondLabel:'VESYL',
    sub:'Ship method & price audit · NetSuite is source of truth',
    sourceOfTruth:'netsuite',
    hideMissingList:true,
    keyFields:[
      {field:'orderNumber', label:'Order Number', ns:'Print Custom', av:'Print Custom', display:'bare'}
    ],
    compareFields:[
      {field:'service', label:'Service', ns:'Service', av:'Service', ignoreTokens:['lightweight']},
      {field:'price',   label:'Price',   ns:'Price',   av:'Price', numeric:true}
    ]
  },
  {
    id:'shopify', title:'Shopify Fulfillments',
    netsuiteUrl:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?saverun=T&scrollid=4830&searchid=4844&refresh=&whence=',
    secondUrl:'https://admin.shopify.com/store/bylt-apparel/orders?savedViewId=21601878118&query=processed_at%3A%3E%3D%222026-08-06%22&order=processed_at+desc&selectedColumns=ORDER_DATE%2CBATCH%2CCUSTOMER_NAME%2CFULFILL_BY%2CCHANNEL%2CTOTAL_PRICE%2CFINANCIAL_STATUS%2CFULFILLMENT_STATUS%2CITEM_COUNT%2CDELIVERY_STATUS%2CDELIVERY_METHOD%2CORDER_TAGS',
    secondLabel:'Shopify',
    sub:'Shopify is source of truth — flags orders Shopify shows unfulfilled but NetSuite already processed',
    sourceOfTruth:'avectous',
    flagMode:'intersection',
    // Scope to Shopify's UNFULFILLED orders specifically — matched Shopify
    // orders (a real Item Fulfillment exists in NetSuite for them) is the
    // actual problem: Shopify hasn't caught up even though NetSuite has
    // already processed it.
    avFilterField:'Fulfillment Status',
    avFilterValue:'unfulfilled',
    missingLabelOverride:'Shopify Unfulfilled but Has a Matching Item Fulfillment in NetSuite',
    flagLabelShort:'unfulfilled, but has an IF',
    keyFields:[
      {field:'orderNumber', label:'Order Number', ns:'Order Number', av:'Name', display:'bare'}
    ],
    compareFields:[]
  },
  {
    id:'shopify_orders', title:'Shopify eCommerce Orders from Celigo',
    netsuiteUrl:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?searchid=4849&saverun=T&whence=',
    secondUrl:'https://admin.shopify.com/store/bylt-apparel/orders?savedViewId=21601878118&query=processed_at%3A%3E%3D%222026-08-06%22&order=processed_at+desc&selectedColumns=ORDER_DATE%2CBATCH%2CCUSTOMER_NAME%2CFULFILL_BY%2CCHANNEL%2CTOTAL_PRICE%2CFINANCIAL_STATUS%2CFULFILLMENT_STATUS%2CITEM_COUNT%2CDELIVERY_STATUS%2CDELIVERY_METHOD%2CORDER_TAGS',
    secondLabel:'Shopify',
    sub:'Order-creation sync audit (via Celigo) · Shopify is source of truth',
    sourceOfTruth:'avectous',
    missingLabelOverride:'Not Synced Yet',
    firstStatLabel:'Orders in Shopify',
    firstStatUsesAv:true,
    analyzedCountLabel:'orders in Shopify',
    matchedStatLabel:'Orders Created',
    missingStatLabel:'Not Synced Yet',
    showLatestNsDate:true,
    latestNsDateField:['Date Created','Date'],
    calculateSyncLag:true,
    syncLagNsField:['Date Created','Date'],
    syncLagAvField:'Created at',
    keyFields:[
      {field:'orderNumber', label:'Order Number', ns:'PO/Check Number', av:'Name', display:'half'}
    ],
    compareFields:[
      // Informational only — NetSuite's own order status and Shopify's
      // financial status use unrelated vocabularies, so this is shown for
      // context rather than flagged as a mismatch.
      {field:'status', label:'Order Status', ns:'Status', av:'Financial Status', skipMatch:true}
    ]
  }
];

/* ===========================================================
   FULFILLMENT SUMMARY — a top-of-dashboard rollup, separate from
   the section-by-section audits above. It answers a different
   question: "of all orders that are ready to ship, how many
   actually have?" It needs three independent files (not a
   NetSuite/Avectous pair like the sections above):
     1. Fulfillable Orders — NetSuite's pool of ready-to-ship orders
     2. NetSuite Fulfilled — NetSuite's already-shipped orders (the
        same search SO Fulfillments uses)
     3. Avectous Shipped — Avectous's shipped-orders export (the
        same file SO/TO Fulfillments' order-level mode uses)
=========================================================== */
const FULFILLMENT_SUMMARY = {
  id:'fulfillment_summary',
  title:'Sales Orders & Transfer Orders Fulfillment Status',
  fulfillableOrdersUrl:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?searchid=4854&saverun=T&whence=',
  netsuiteFulfilledUrl:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?searchid=4830&saverun=T&whence=',
  avectousShippedUrl:'https://bylt.avectous.com/portal/frameworkpage/62c9bee6-310c-46bf-4c3b-08deafb23cf9/542dc233-d6c6-4d03-bf52-cf5f252218b1/33d41bbb-b683-4fd1-b632-b4a3a9f83eb1'
};

const FULFILLMENT_SHIPPED_STATUSES = ['partiallyfulfilled','billed','pendingbilling','pendingbillingpartiallyfulfilled','received','pendingreceipt'];
const FULFILLMENT_NOTSHIPPED_STATUSES = ['pendingfulfillment'];
const FULFILLMENT_EXCLUDED_STATUSES = ['closed','pendingapproval'];

function parseDateRobust(raw){
  if(raw instanceof Date) return raw;
  if(raw === null || raw === undefined || raw === '') return null;
  if(typeof raw === 'number'){
    // A raw Excel serial date (days since 1899-12-30) leaking through as a
    // plain number, rather than being converted to a real Date first.
    // Excel serials in a sane range (year ~1950 to ~2200) fall roughly
    // between 18000 and 110000. new Date(number) instead treats it as
    // milliseconds since epoch, landing on a nonsense date near 1970-01-01.
    if(raw > 15000 && raw < 110000){
      return new Date((raw - 25569) * 86400 * 1000);
    }
    return new Date(raw);
  }
  return new Date(raw);
}

function buildFulfillmentSlim(fulfillableData, nsFulfilledData, avShippedData){
  const orderCol = guessColumn(fulfillableData.headers, 'PO/Check Number');
  const typeCol = guessColumn(fulfillableData.headers, 'Type');
  const statusCol = guessColumn(fulfillableData.headers, 'Status');
  const dateCol = guessColumn(fulfillableData.headers, 'Date');

  // "Fulfillable" now means: NetSuite's own order Status is anything except
  // Closed (cancelled) or Pending Approval (not yet ready to ship) — a much
  // broader set than the old "WMS Status = Pending Fulfillment only" filter.
  // Within that broader set, Status further splits each order into Shipped
  // (Partially Fulfilled, Billed, Pending Billing, Pending Billing/Partially
  // Fulfilled, Received, Pending Receipt) or Not Shipped (Pending Fulfillment).
  // Any status outside this known list is excluded rather than guessed at,
  // and surfaced separately so an unmapped status doesn't silently miscount.
  const unmappedStatuses = new Set();
  const slimRows = fulfillableData.rows
    .filter(row=>{
      if(!statusCol) return true;
      const s = norm(row[statusCol]);
      if(FULFILLMENT_EXCLUDED_STATUSES.includes(s)) return false;
      if(FULFILLMENT_SHIPPED_STATUSES.includes(s) || FULFILLMENT_NOTSHIPPED_STATUSES.includes(s)) return true;
      unmappedStatuses.add(row[statusCol]);
      return false;
    })
    .map(row=>{
      const raw = dateCol ? row[dateCol] : null;
      const d = parseDateRobust(raw);
      const tRaw = typeCol ? norm(row[typeCol]) : '';
      const sRaw = statusCol ? norm(row[statusCol]) : '';
      return {
        d: (d && !isNaN(d.getTime())) ? d.toISOString().slice(0,10) : null,
        o: orderCol ? row[orderCol] : null,
        t: tRaw === 'salesorder' ? 'SO' : tRaw === 'transferorder' ? 'TO' : 'SO',
        shipped: FULFILLMENT_SHIPPED_STATUSES.includes(sRaw)
      };
    });

  const nsFulfilledProvided = !!(nsFulfilledData && nsFulfilledData.rows && nsFulfilledData.rows.length);
  const avShippedProvided = !!(avShippedData && avShippedData.rows && avShippedData.rows.length);
  let nsFulfilledList = [], avShippedSoList = [], avShippedToList = [];
  if(nsFulfilledProvided){
    const col = guessColumn(nsFulfilledData.headers, ['PO/Check Number','OrderNumber']);
    if(col) nsFulfilledList = nsFulfilledData.rows.filter(r=>r[col]).map(r=>norm(r[col]));
  }
  if(avShippedProvided){
    const col = guessColumn(avShippedData.headers, 'OrderNumber');
    const typeC = guessColumn(avShippedData.headers, 'OrderType');
    avShippedData.rows.forEach(r=>{
      if(!r[col]) return;
      const t = typeC ? norm(r[typeC]) : '';
      if(t === 'shpy' || !typeC) avShippedSoList.push(norm(r[col]));
      if(t === 'tos') avShippedToList.push(norm(r[col]));
    });
  }
  return { slimRows, nsFulfilledList, avShippedSoList, avShippedToList, nsFulfilledProvided, avShippedProvided, unmappedStatuses: [...unmappedStatuses] };
}

function recomputeFulfillmentSummary(slim, dateFrom, dateTo){
  const fromD = dateFrom ? new Date(dateFrom) : null;
  const toD = dateTo ? new Date(dateTo) : null;
  if(toD) toD.setHours(23,59,59,999);

  const filtered = slim.slimRows.filter(r=>{
    if(!r.d) return false;
    const d = new Date(r.d + 'T00:00:00');
    if(fromD && d < fromD) return false;
    if(toD && d > toD) return false;
    return true;
  });
  const soRows = filtered.filter(r => r.t === 'SO');
  const toRows = filtered.filter(r => r.t === 'TO');

  // "What day is the warehouse at" — the most recent order date among
  // everything already shipped. If they've shipped orders placed as late
  // as Aug 12 but not touched most of Aug 13-14 yet, that's a direct,
  // honest answer: caught up through Aug 12.
  let caughtUpThrough = null;
  filtered.forEach(r=>{
    if(r.shipped && r.d){
      const d = new Date(r.d + 'T00:00:00');
      // Guard against invalid/epoch dates — a real order date should never
      // resolve to 1970. If it does, something upstream failed to parse
      // correctly; better to show nothing than a nonsensical date.
      if(isNaN(d.getTime()) || d.getFullYear() < 2000) return;
      if(!caughtUpThrough || d > caughtUpThrough) caughtUpThrough = d;
    }
  });

  const nsSet = new Set(slim.nsFulfilledList);
  const avSoSet = new Set(slim.avShippedSoList);
  const avToSet = new Set(slim.avShippedToList);

  function countMatches(rows, set, provided){
    if(!provided) return null;
    const usable = rows.filter(r => r.o && norm(r.o) !== norm('- None -'));
    if(rows.length && usable.length === 0) return null;
    return usable.filter(r => set.has(norm(r.o))).length;
  }

  // "Synced" specifically means BOTH systems agree — Avectous has shipped
  // it AND NetSuite reflects it. Checking NetSuite alone would count an
  // order NetSuite marked fulfilled even if Avectous never actually shipped
  // it, which isn't really "sync" — it's just NetSuite's own status.
  function countBothMatch(rows, nsSet, avSet, nsProvided, avProvided){
    if(!nsProvided || !avProvided) return null;
    const usable = rows.filter(r => r.o && norm(r.o) !== norm('- None -'));
    if(rows.length && usable.length === 0) return null;
    return usable.filter(r => nsSet.has(norm(r.o)) && avSet.has(norm(r.o))).length;
  }

  const soFulfilledNs = countMatches(soRows, nsSet, slim.nsFulfilledProvided);
  const soFulfilledAv = countMatches(soRows, avSoSet, slim.avShippedProvided);
  const toFulfilledNs = countMatches(toRows, nsSet, slim.nsFulfilledProvided);
  const toFulfilledAv = countMatches(toRows, avToSet, slim.avShippedProvided);

  const totalFulfillable = soRows.length + toRows.length;
  const totalFulfilledAv = (soFulfilledAv || 0) + (toFulfilledAv || 0);
  const pctShippedAv = totalFulfillable ? (totalFulfilledAv / totalFulfillable * 100) : 0;
  const soSyncedBoth = countBothMatch(soRows, nsSet, avSoSet, slim.nsFulfilledProvided, slim.avShippedProvided);
  const toSyncedBoth = countBothMatch(toRows, nsSet, avToSet, slim.nsFulfilledProvided, slim.avShippedProvided);
  const nsDataAvailable = soSyncedBoth !== null || toSyncedBoth !== null;
  const totalSyncedBoth = (soSyncedBoth || 0) + (toSyncedBoth || 0);
  const pctShippedNs = (nsDataAvailable && totalFulfilledAv) ? (totalSyncedBoth / totalFulfilledAv * 100) : null;

  // Status-based Shipped/Not Shipped — a NetSuite-status classification,
  // separate from (and complementary to) the Avectous/NetSuite cross-reference
  // checks above. This is about where NetSuite's own order status sits, not
  // whether another system has independently confirmed the shipment.
  const soShipped = soRows.filter(r => r.shipped).length;
  const toShipped = toRows.filter(r => r.shipped).length;
  const totalShipped = soShipped + toShipped;
  const totalNotShipped = totalFulfillable - totalShipped;

  return {
    totalFulfillable, soCount: soRows.length, toCount: toRows.length,
    soFulfilledNs, soFulfilledAv, toFulfilledNs, toFulfilledAv,
    pctShippedAv, pctShippedNs, dateFrom, dateTo,
    totalShipped, totalNotShipped,
    soShipped, soNotShipped: soRows.length - soShipped,
    toShipped, toNotShipped: toRows.length - toShipped,
    caughtUpThrough: caughtUpThrough ? caughtUpThrough.toISOString().slice(0,10) : null
  };
}

function computeFulfillmentSummary(fulfillableData, nsFulfilledData, avShippedData, dateFrom, dateTo){
  const slim = buildFulfillmentSlim(fulfillableData, nsFulfilledData, avShippedData);
  return { ...recomputeFulfillmentSummary(slim, dateFrom, dateTo), _slim: slim };
}

/* ===========================================================
   STORAGE — this is how the Data page and Dashboard page
   talk to each other. Everything lives in the browser
   (localStorage), scoped to whatever domain hosts these
   two pages together (e.g. your Netlify site).
=========================================================== */
const STORAGE_PREFIX = 'bylt_recon_';

function saveSectionResult(sectionId, resultObj, ranBy){
  // Local storage is just a fallback for when the shared server sync fails —
  // the server copy (via syncToShared, unaffected by any of this) is the
  // real source of truth and has no comparable size limit. Browsers cap
  // total localStorage per origin at roughly 5-10MB, and with 9 sections
  // each potentially holding thousands of rows, storing full data locally
  // for every section isn't sustainable. So the local copy is deliberately
  // lightweight, with tiers that degrade further only if needed:
  //   1. Drop the full line-by-line comparison (mainly used for exports —
  //      regenerable, and still present in the full server-synced copy)
  //   2. If still too large, also cap the missing/discrepancy lists (the
  //      counts stay accurate either way — only the row-level detail caps)
  //   3. If STILL too large, keep only the numeric summary — this tier
  //      can never realistically fail regardless of dataset size
  const stripLedger = obj => {
    if(!obj || typeof obj !== 'object') return obj;
    const out = { ...obj };
    ['so','to'].forEach(side=>{
      if(out[side] && out[side].ledger) out[side] = { ...out[side], ledger: [], ledgerDroppedLocally: true };
    });
    return out;
  };
  const tier0 = stripLedger(resultObj);
  const tier1 = { ...tier0, lineComparison: [], lineComparisonTruncatedLocally: true };
  const tier2 = { ...tier1, missingRows: (resultObj.missingRows||[]).slice(0,500), discrepancies: (resultObj.discrepancies||[]).slice(0,500), rowsTruncatedLocally: true };
  const tier3 = {
    totalNs: resultObj.totalNs, totalAv: resultObj.totalAv, matchedCount: resultObj.matchedCount,
    totalMissing: resultObj.totalMissing, missingLabel: resultObj.missingLabel,
    discrepanciesCount: (resultObj.discrepancies||[]).length, orderAudit: resultObj.orderAudit,
    missingRows: [], discrepancies: [], lineComparison: [], summaryOnlyLocally: true
  };

  let saved = false;
  for(const attempt of [resultObj, tier0, tier1, tier2, tier3]){
    try{
      localStorage.setItem(STORAGE_PREFIX + sectionId, JSON.stringify(attempt));
      saved = true;
      break;
    } catch(err){
      console.warn(`Local storage attempt failed for "${sectionId}" (${err.message}) — trying a lighter fallback.`);
    }
  }
  if(!saved){
    console.error(`Local storage failed entirely for "${sectionId}" even at minimum size — shared server sync is the only copy.`);
  } else {
    localStorage.setItem(STORAGE_PREFIX + sectionId + '_savedAt', new Date().toISOString());
    if(ranBy) localStorage.setItem(STORAGE_PREFIX + sectionId + '_ranBy', ranBy);
  }
}
function loadSectionResult(sectionId){
  const raw = localStorage.getItem(STORAGE_PREFIX + sectionId);
  return raw ? JSON.parse(raw) : null;
}
function loadSectionSavedAt(sectionId){
  return localStorage.getItem(STORAGE_PREFIX + sectionId + '_savedAt');
}
function loadSectionRanBy(sectionId){
  return localStorage.getItem(STORAGE_PREFIX + sectionId + '_ranBy');
}
function getLastUsedName(){
  return localStorage.getItem(STORAGE_PREFIX + 'last_name') || '';
}
function setLastUsedName(name){
  if(name) localStorage.setItem(STORAGE_PREFIX + 'last_name', name);
}
function clearAllResults(){
  SECTIONS.forEach(s=>{
    localStorage.removeItem(STORAGE_PREFIX + s.id);
    localStorage.removeItem(STORAGE_PREFIX + s.id + '_savedAt');
    localStorage.removeItem(STORAGE_PREFIX + s.id + '_ranBy');
  });
}
async function clearSectionResult(sectionId){
  localStorage.removeItem(STORAGE_PREFIX + sectionId);
  localStorage.removeItem(STORAGE_PREFIX + sectionId + '_savedAt');
  localStorage.removeItem(STORAGE_PREFIX + sectionId + '_ranBy');
  try{
    await fetch('/api/data', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sectionId })
    });
  } catch(err){
    // Local copy is cleared either way; shared copy will just reappear
    // on next refresh if this fails, which is a safe fallback.
  }
}

async function loadSharedResults(){
  try{
    const res = await fetch('/api/data');
    if(!res.ok) return {};
    return await res.json(); // { sectionId: { result, savedAt } }
  } catch(err){
    return {};
  }
}

async function logout(){
  try{ await fetch('/api/logout', { method: 'POST' }); } catch(err){}
  window.location.href = 'login.html';
}

/* ===========================================================
   HELPERS
=========================================================== */
function norm(s){ return String(s===undefined||s===null?'':s).trim().toLowerCase().replace(/[^a-z0-9]/g,''); }
function getEffectiveSection(s, auditLevel){
  if(s.supportsAuditLevelToggle && auditLevel === 'order' && s.orderLevelVariant){
    return {
      ...s,
      keyFields: s.orderLevelVariant.keyFields,
      compareFields: s.orderLevelVariant.compareFields,
      flagMode: s.orderLevelVariant.flagMode,
      flagLabelShort: s.orderLevelVariant.flagLabelShort,
      missingLabelOverride: s.orderLevelVariant.missingLabelOverride || s.missingLabelOverride,
      avFilterField: s.orderLevelVariant.avFilterField,
      avFilterValue: s.orderLevelVariant.avFilterValue
    };
  }
  return s;
}

function guessColumn(headers, target){
  // target can be a single name, or an array of candidate names to try in
  // priority order (e.g. ['Qty', 'Quantity']) — some export variants only
  // have one or the other for what's conceptually the same field. Trying
  // the first candidate across ALL headers before falling to the next
  // candidate keeps priority correct (an exact match on the 2nd candidate
  // still loses to an exact match on the 1st, even if checked later).
  const candidates = Array.isArray(target) ? target : [target];
  for(const cand of candidates){
    const nt = norm(cand);
    const exact = headers.find(h=>norm(h)===nt);
    if(exact) return exact;
  }
  for(const cand of candidates){
    const nt = norm(cand);
    const contains = headers.find(h=>norm(h).includes(nt) || nt.includes(norm(h)));
    if(contains) return contains;
  }
  // No fallback to headers[0] here on purpose — guessing an unrelated column
  // (e.g. "Date" when "Line" doesn't exist) silently corrupts every match.
  // Returning null lets the caller treat "not found" as "not found."
  return null;
}
function normVal(v, numeric){
  if(v===undefined||v===null) return numeric? 0 : '';
  let s = String(v).trim();
  if(numeric){ s = s.replace(/,/g,''); const n = parseFloat(s); return isNaN(n) ? 0 : n; }
  return s.toLowerCase();
}
function keyOf(row, keyFields, mapping, side){
  return keyFields.map(kf=>norm(row[mapping[kf.field][side]])).join('||');
}
function isSummaryOrEmptyRow(row, keyFields, mapping, side){
  const values = keyFields.map(kf => String(row[mapping[kf.field][side]] ?? '').trim());
  // Fully blank row (common trailing artifact in exports)
  if(values.every(v => v === '')) return true;
  // NetSuite/Avectous summary rows like "Total", "Overall Total", "Grand Total", "Subtotal",
  // or an "All Products"-style aggregate row (seen in Avectous's Inventory Report) — checked
  // against every key field, since which column holds the label varies by export.
  return values.some(v => /^(overall\s+)?(grand\s+)?(sub)?total$/i.test(v) || /^all\s+products?$/i.test(v));
}
function downloadCSV(filename, rows){
  if(!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(',')].concat(
    rows.map(r=>headers.map(h=>{
      let v = r[h]===undefined||r[h]===null?'':String(r[h]);
      if(v.includes(',')||v.includes('"')||v.includes('\n')) v = '"'+v.replace(/"/g,'""')+'"';
      return v;
    }).join(','))
  ).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function escapeHtml(str){ return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeAttr(str){ return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

/* ===========================================================
   COMPARISON ENGINE — given parsed NS/AV rows + a column
   mapping, returns { totalNs, totalAv, totalMissing,
   missingRows, missingLabel, discrepancies }
=========================================================== */
function computeComparison(s, nsData, avData, mapping, supplementaryData){
  // Only match on key fields that actually exist in BOTH files. A field
  // missing from one side (mapping is null) would otherwise silently
  // corrupt the match key — e.g. every NetSuite row contributing a blank
  // "Line" while Avectous contributes real line numbers, guaranteeing
  // zero matches even when the underlying orders line up perfectly.
  const effectiveKeyFields = s.keyFields.filter(kf => mapping[kf.field].ns && mapping[kf.field].av);
  const excludedKeyFields = s.keyFields.filter(kf => !(mapping[kf.field].ns && mapping[kf.field].av));
  const effectiveCompareFields = s.compareFields.filter(cf => mapping[cf.field].ns && mapping[cf.field].av);
  const excludedCompareFields = s.compareFields.filter(cf => !(mapping[cf.field].ns && mapping[cf.field].av));

  // If the key doesn't include Line (or any other line-level field), the same
  // order+product can legitimately appear more than once (split shipments,
  // backorders across lines). Rather than silently keeping only the first
  // occurrence and losing the rest, numeric compare fields (e.g. Qty) get
  // summed across duplicates; non-numeric fields keep the first value seen.
  function mergeDuplicate(existing, incoming, side){
    const merged = { ...existing };
    effectiveCompareFields.forEach(cf=>{
      const col = mapping[cf.field][side];
      if(cf.numeric){
        merged[col] = normVal(existing[col], true) + normVal(incoming[col], true);
      }
      // non-numeric fields: keep whatever the first occurrence had
    });
    return merged;
  }

  function shouldSkipZeroQty(row, section, fieldMapping, side){
    const zeroField = section.compareFields.find(cf => cf.skipIfZero);
    if(!zeroField) return false;
    const col = fieldMapping[zeroField.field][side];
    if(!col) return false;
    return normVal(row[col], true) === 0;
  }

  const nsIndex = new Map();
  nsData.rows.forEach(row=>{
    if(isSummaryOrEmptyRow(row, s.keyFields, mapping, 'ns')) return;
    if(shouldSkipZeroQty(row, s, mapping, 'ns')) return;
    const k = keyOf(row, effectiveKeyFields, mapping, 'ns');
    if(nsIndex.has(k)){
      nsIndex.set(k, mergeDuplicate(nsIndex.get(k), row, 'ns'));
    } else {
      nsIndex.set(k, row);
    }
  });
  const avIndex = new Map();
  avData.rows.forEach(row=>{
    if(s.avFilterField && s.avFilterValue !== undefined){
      const col = guessColumn(avData.headers, s.avFilterField);
      if(col && norm(row[col]) !== norm(s.avFilterValue)) return; // wrong order type for this section
    }
    if(isSummaryOrEmptyRow(row, s.keyFields, mapping, 'av')) return;
    if(shouldSkipZeroQty(row, s, mapping, 'av')) return;
    const k = keyOf(row, effectiveKeyFields, mapping, 'av');
    if(avIndex.has(k)){
      avIndex.set(k, mergeDuplicate(avIndex.get(k), row, 'av'));
    } else {
      avIndex.set(k, row);
    }
  });

  const nsKeys = new Set(nsIndex.keys());
  const avKeys = new Set(avIndex.keys());
  const onlyInNs = [...nsKeys].filter(k=>!avKeys.has(k));
  const onlyInAv = [...avKeys].filter(k=>!nsKeys.has(k));
  const matched = [...nsKeys].filter(k=>avKeys.has(k));

  // Order-level audit: "lines missing" (existing metric) counts individual
  // records — an order with 3 products missing 1 counts as 1 line missing,
  // not 1 order missing. "Orders missing" counts distinct transactions
  // (grouped by the first key field — Order Number, ERNo, etc.) where
  // NONE of that transaction's lines exist on the other side at all.
  // Doesn't apply to Inventory (no order concept — pure per-SKU comparison).
  let orderAudit = null;
  if(s.flagMode !== 'intersection' && (s.sourceOfTruth === 'netsuite' || s.sourceOfTruth === 'avectous') && effectiveKeyFields.length){
    const truthIndex = s.sourceOfTruth === 'netsuite' ? nsIndex : avIndex;
    const truthSide = s.sourceOfTruth === 'netsuite' ? 'ns' : 'av';
    const otherKeys = s.sourceOfTruth === 'netsuite' ? avKeys : nsKeys;
    const primaryField = effectiveKeyFields[0];
    const orderGroups = new Map(); // orderValue -> {total, missing}
    for(const [key, row] of truthIndex){
      const orderVal = norm(row[mapping[primaryField.field][truthSide]]);
      const g = orderGroups.get(orderVal) || {total:0, missing:0};
      g.total++;
      if(!otherKeys.has(key)) g.missing++;
      orderGroups.set(orderVal, g);
    }
    let ordersFullyMissing = 0;
    for(const g of orderGroups.values()){
      if(g.missing === g.total) ordersFullyMissing++;
    }
    orderAudit = { ordersTotal: orderGroups.size, ordersFullyMissing };
  }

  // Open Receipts cross-reference: a mismatch where the SKU has an OPEN
  // (not-yet-received) receipt line isn't really a discrepancy — it's just
  // inventory sitting in transit that hasn't posted yet. Flag those
  // separately from genuine, unexplained mismatches.
  let openReceiptSkus = new Set();
  if(s.supplementaryFile && supplementaryData && supplementaryData.rows && supplementaryData.rows.length){
    const sf = s.supplementaryFile;
    const skuCol = guessColumn(supplementaryData.headers, sf.keyField);
    const statusCol = guessColumn(supplementaryData.headers, sf.statusField);
    if(skuCol){
      supplementaryData.rows.forEach(row=>{
        if(statusCol && norm(row[statusCol]) !== norm(sf.openValue)) return;
        openReceiptSkus.add(norm(row[skuCol]));
      });
    }
  }

  const discrepancies = [];
  let totalUnitDiscrepancy = 0, explainedMismatchCount = 0, unexplainedMismatchCount = 0;
  function valuesMatch(nsRaw, avRaw, valueMap, numeric, ignoreTokens){
    if(numeric) return normVal(nsRaw, true) === normVal(avRaw, true);
    const nsNorm = norm(nsRaw), avNorm = norm(avRaw);
    if(nsNorm === avNorm) return true; // direct match always wins first
    if(valueMap){
      const key = String(nsRaw ?? '').trim().toLowerCase();
      if(key in valueMap){
        const candidates = Array.isArray(valueMap[key]) ? valueMap[key] : [valueMap[key]];
        if(candidates.some(c => norm(c) === avNorm)) return true;
      }
    }
    if(ignoreTokens && ignoreTokens.length){
      // A qualifier word that shows up inconsistently on either side (e.g.
      // "Lightweight" appearing on NetSuite's value sometimes and Avectous's
      // other times, with no reliable pattern) — strip it from BOTH sides
      // symmetrically rather than needing every possible pairwise mapping.
      let nsStripped = nsNorm, avStripped = avNorm;
      ignoreTokens.forEach(t=>{
        const nt = norm(t);
        nsStripped = nsStripped.split(nt).join('');
        avStripped = avStripped.split(nt).join('');
      });
      if(nsStripped === avStripped) return true;
    }
    return false;
  }

  matched.forEach(k=>{
    const nsRow = nsIndex.get(k), avRow = avIndex.get(k);
    effectiveCompareFields.filter(cf => !cf.skipMatch).forEach(cf=>{
      const nsCol = mapping[cf.field].ns, avCol = mapping[cf.field].av;
      const nsRaw = nsRow[nsCol], avRaw = avRow[avCol];
      const isMatchOk = valuesMatch(nsRaw, avRaw, cf.valueMap, cf.numeric, cf.ignoreTokens);
      const nsV = normVal(nsRaw, cf.numeric), avV = normVal(avRaw, cf.numeric);
      if(!isMatchOk){
        const idParts = {};
        s.keyFields.forEach(kf=>{ idParts[kf.label] = nsRow[mapping[kf.field].ns]; });
        const isExplained = s.supplementaryFile && openReceiptSkus.has(k);
        const statusText = isExplained ? `Mismatch - ${s.supplementaryFile.label} (Not Yet Received)` : 'Mismatch';
        discrepancies.push({ ...idParts, 'Field':cf.label, 'NetSuite Value':nsRaw, 'Avectous Value':avRaw, 'Difference': cf.numeric ? (avV - nsV) : '', 'Status': statusText });
        if(isExplained) explainedMismatchCount++; else unexplainedMismatchCount++;
        if(cf.numeric && !isExplained) totalUnitDiscrepancy += Math.abs(avV - nsV);
      }
    });
  });

  function rowToDisplay(row, side){
    const out = {};
    s.keyFields.forEach(kf=>{ out[kf.label] = row[mapping[kf.field][side]]; });
    const dateCol = guessColumn(Object.keys(row), ['Date','LastShipDate','WMS Export Date','Ship Date']);
    if(dateCol && row[dateCol] !== undefined && !(dateCol in out)){
      out['Date'] = row[dateCol];
    }
    return out;
  }

  // Line-level comparison export, matching the reference format:
  // - Every original NetSuite column preserved as-is
  // - "Internal ID" relabeled to "NetSuite Internal ID" for clarity
  // - Fields marked plain:true (e.g. Order Number, Line) stay a single
  //   passthrough column — they're structural identifiers, not something
  //   that needs its own Match flag
  // - Every other key/compare field (ProductId, Qty, etc.) gets its raw
  //   passthrough column replaced by an explicit (NetSuite)/(Avectous) pair
  //
  // Scope: when one system is the source of truth, the export only covers
  // that system's records — not the full union of both sides. Otherwise a
  // NetSuite-authoritative section could get flooded with unrelated
  // Avectous-only history that was never supposed to be in scope.
  const allFields = [...s.keyFields, ...s.compareFields];
  const scopeKeys = s.hideMissingList ? matched
    : s.sourceOfTruth === 'netsuite' ? nsKeys
    : s.sourceOfTruth === 'avectous' ? avKeys
    : new Set([...nsKeys, ...avKeys]);
  const lineComparison = [...scopeKeys].map(k=>{
    const nsRow = nsIndex.get(k) || null;
    const avRow = avIndex.get(k) || null;
    const row = {};

    if(nsRow){
      Object.assign(row, nsRow); // preserve every original NetSuite column as-is
      if('Internal ID' in row){
        row['NetSuite Internal ID'] = row['Internal ID'];
        delete row['Internal ID'];
      }
    } else {
      // No NetSuite record — still give identifying key values, sourced from Avectous
      s.keyFields.forEach(kf=>{ row[kf.label] = avRow[mapping[kf.field].av]; });
    }

    if(s.flagMode === 'intersection'){
      // The whole point of this export is showing which records are
      // flagged (found in both lists) — 'bare' display would otherwise
      // skip adding any indicator at all, leaving a plain list with no
      // way to tell which row is actually the problem.
      row[s.missingLabelOverride || 'Flagged'] = nsRow ? 'TRUE' : 'FALSE';
    }

    allFields.forEach(f=>{
      const availableBothSides = mapping[f.field].ns && mapping[f.field].av;
      const nsRaw = nsRow ? nsRow[mapping[f.field].ns] : '';
      const avRaw = avRow ? avRow[mapping[f.field].av] : '';
      const display = f.display || (f.plain ? 'half' : 'full'); // f.plain kept for backwards compatibility

      if(display === 'bare'){
        return; // single passthrough column already present from Object.assign — nothing more to add
      }

      if(display === 'full' && nsRow && mapping[f.field].ns in nsRow){
        delete row[mapping[f.field].ns]; // drop the raw duplicate, replaced by the labeled pair below
      }

      if(display === 'half'){
        row[`${f.label} (Avectous)`] = avRow ? avRaw : '';
      } else {
        row[`${f.label} (NetSuite)`] = nsRow ? nsRaw : '';
        row[`${f.label} (Avectous)`] = avRow ? avRaw : '';
      }

      if(!availableBothSides || f.skipMatch || !nsRow || !avRow){
        row[`${f.label} Match`] = 'N/A';
      } else {
        const isMatch = valuesMatch(nsRaw, avRaw, f.valueMap, f.numeric, f.ignoreTokens);
        row[`${f.label} Match`] = isMatch ? 'TRUE' : 'FALSE';
      }
    });
    row._bothSidesPresent = !!(nsRow && avRow); // temporary — used for sorting only, stripped before export

    return row;
  });
  // Mismatches and missing records first, clean full matches last.
  // Fields marked N/A (not available in one of the files) don't count
  // against a record — only real mismatches push it up in priority.
  lineComparison.sort((a, b) => {
    if(s.flagMode === 'intersection'){
      const flagCol = s.missingLabelOverride || 'Flagged';
      const rank = r => r[flagCol] === 'TRUE' ? 0 : 1; // flagged rows first
      return rank(a) - rank(b);
    }
    const isCleanMatch = r => (r._bothSidesPresent && allFields.every(f => r[`${f.label} Match`] !== 'FALSE')) ? 1 : 0;
    return isCleanMatch(a) - isCleanMatch(b);
  });
  lineComparison.forEach(r => { delete r._bothSidesPresent; });

  const secondName = s.secondLabel || 'Avectous';
  let missingRows = [], missingLabel = '';
  function collapseToOrderLevel(keys, index, side){
    const primaryField = s.keyFields[0];
    const seen = new Set();
    const rows = [];
    keys.forEach(k=>{
      const row = index.get(k);
      const orderVal = row[mapping[primaryField.field][side]];
      const key = norm(orderVal);
      if(seen.has(key)) return;
      seen.add(key);
      const entry = { [primaryField.label]: orderVal };
      const dateCol = guessColumn(Object.keys(row), 'Date');
      if(dateCol && row[dateCol] !== undefined) entry['Date'] = row[dateCol];
      rows.push(entry);
    });
    return rows;
  }
  if(s.flagMode === 'intersection'){
    // Flag the records present in BOTH lists — e.g. an order sitting in
    // NetSuite's "unfulfilled" list that's ALSO in Avectous's "shipped"
    // list can only mean one thing: Avectous already shipped it, but
    // NetSuite hasn't caught up. This inverts the usual logic (normally
    // "missing" means present in one system but not the other).
    missingRows = matched.map(k=>{
      const nsRow = nsIndex.get(k), avRow = avIndex.get(k);
      const combined = { ...rowToDisplay(nsRow, 'ns') };
      s.compareFields.forEach(cf=>{
        if(mapping[cf.field].av) combined[`${cf.label} (${secondName})`] = avRow[mapping[cf.field].av];
      });
      return combined;
    });
    missingLabel = s.missingLabelOverride || `Found in both — flagged`;
  } else if(s.sourceOfTruth === 'netsuite'){
    missingRows = s.collapseMissingToOrderLevel
      ? collapseToOrderLevel(onlyInNs, nsIndex, 'ns')
      : onlyInNs.map(k=>rowToDisplay(nsIndex.get(k), 'ns'));
    missingLabel = s.missingLabelOverride || `In NetSuite, missing from ${secondName}`;
  } else if(s.sourceOfTruth === 'avectous'){
    missingRows = s.collapseMissingToOrderLevel
      ? collapseToOrderLevel(onlyInAv, avIndex, 'av')
      : onlyInAv.map(k=>rowToDisplay(avIndex.get(k), 'av'));
    missingLabel = s.missingLabelOverride || `In ${secondName}, missing from NetSuite`;
  } else {
    missingRows = onlyInNs.map(k=>({...rowToDisplay(nsIndex.get(k), 'ns'), 'Found In':'NetSuite only'}))
      .concat(onlyInAv.map(k=>({...rowToDisplay(avIndex.get(k), 'av'), 'Found In':`${secondName} only`})));
    missingLabel = s.missingLabelOverride || 'Only found in one system';
  }

  let latestNsDate = null;
  if(s.showLatestNsDate && nsIndex.size){
    let sampleRow = nsIndex.values().next().value;
    const dateCol = guessColumn(Object.keys(sampleRow), s.latestNsDateField || 'Date');
    if(dateCol){
      for(const row of nsIndex.values()){
        const raw = row[dateCol];
        const d = raw instanceof Date ? raw : new Date(raw);
        if(!isNaN(d.getTime()) && (!latestNsDate || d > latestNsDate)) latestNsDate = d;
      }
    }
  }

  // Sync-lag: for matched orders, how long between creation in the source
  // system (Avectous/Shopify) and creation in NetSuite. Only meaningful
  // when both sides have a real timestamp (not just a date at midnight).
  let syncLag = null;
  if(s.calculateSyncLag && matched.length){
    const sampleNs = nsIndex.values().next().value;
    const sampleAv = avIndex.values().next().value;
    const nsDateCol = guessColumn(Object.keys(sampleNs), s.syncLagNsField);
    const avDateCol = guessColumn(Object.keys(sampleAv), s.syncLagAvField);
    if(nsDateCol && avDateCol){
      // NetSuite's timestamp shares the same local clock as the second
      // system's (e.g. Shopify) but often lacks an explicit timezone
      // marker, which makes JS default to UTC — silently introducing a
      // multi-hour error. Fix: pull the actual offset straight from the
      // second system's own timestamp string (handles DST correctly,
      // since that offset already reflects whatever's right for the date)
      // and apply it to NetSuite's timestamp before parsing.
      const offsetPattern = /([+-]\d{2}:?\d{2})\s*$/;
      function parseWithSharedOffset(nsRaw, avRawForOffset){
        if(nsRaw instanceof Date) return nsRaw;
        const nsStr = String(nsRaw ?? '');
        if(/[+-]\d{2}:?\d{2}$|Z$/.test(nsStr.trim())) return new Date(nsStr); // already has its own offset
        const m = String(avRawForOffset ?? '').match(offsetPattern);
        const offset = m ? m[1].replace(/(\d{2})(\d{2})$/, '$1:$2') : '';
        return new Date(nsStr.trim() + offset);
      }

      const lagsHours = [];
      const perOrderLag = [];
      matched.forEach(k=>{
        const nsRow = nsIndex.get(k), avRow = avIndex.get(k);
        const avRaw = avRow[avDateCol];
        const nsD = parseWithSharedOffset(nsRow[nsDateCol], avRaw);
        const avD = avRaw instanceof Date ? avRaw : new Date(avRaw);
        if(!isNaN(nsD.getTime()) && !isNaN(avD.getTime())){
          const hours = (nsD.getTime() - avD.getTime()) / 3600000;
          lagsHours.push(hours);
          perOrderLag.push({ key: k, hours });
        }
      });
      if(lagsHours.length){
        const avgHours = lagsHours.reduce((a,b)=>a+b, 0) / lagsHours.length;
        const sorted = [...lagsHours].sort((a,b)=>a-b);
        const medianHours = sorted[Math.floor(sorted.length/2)];
        syncLag = {
          sampleSize: lagsHours.length,
          avgHours, medianHours,
          minHours: sorted[0], maxHours: sorted[sorted.length-1],
          perOrder: perOrderLag
        };
      }
    }
  }

  let inventoryStats = null;
  let inventoryComparisonRows = null;
  if(s.supplementaryFile || s.id === 'inv'){
    let totalAvUnits = 0;
    const qtyField = effectiveCompareFields.find(cf => cf.numeric);
    if(qtyField){
      for(const row of avIndex.values()){
        totalAvUnits += normVal(row[mapping[qtyField.field].av], true);
      }
    }
    // Only unexplained mismatches count toward the rate — an open-receipt-
    // explained mismatch isn't a real discrepancy, just inventory in transit
    // that hasn't posted yet. A rate meant to flag real problems shouldn't
    // be diluted by ones that already have a known, benign explanation.
    const skuDiscrepancyRate = avIndex.size ? (unexplainedMismatchCount / avIndex.size * 100) : 0;
    const qtyDiscrepancyRate = totalAvUnits ? (totalUnitDiscrepancy / totalAvUnits * 100) : 0;
    inventoryStats = {
      totalAvUnits, totalUnitDiscrepancy,
      explainedMismatchCount, unexplainedMismatchCount,
      skuDiscrepancyRate, qtyDiscrepancyRate
    };

    // Per-SKU rows matching the reference report's exact Comparison sheet
    // layout: SKU, Avectous Total Qty, NS On Hand, Status, Discrepancy, Open receipts.
    if(qtyField){
      inventoryComparisonRows = [];
      for(const k of avIndex.keys()){
        const avRow = avIndex.get(k);
        const nsRow = nsIndex.get(k);
        const avQty = normVal(avRow[mapping[qtyField.field].av], true);
        const nsQty = nsRow ? normVal(nsRow[mapping[qtyField.field].ns], true) : 0;
        const isMatch = nsRow && avQty === nsQty;
        const isOpen = openReceiptSkus.has(k);
        let status;
        if(!nsRow) status = isOpen ? `Mismatch - ${s.supplementaryFile ? s.supplementaryFile.label : 'Open Receipt'} (Not Yet Received)` : 'Mismatch - Missing from NetSuite';
        else if(isMatch) status = 'Match';
        else status = isOpen ? `Mismatch - ${s.supplementaryFile ? s.supplementaryFile.label : 'Open Receipt'} (Not Yet Received)` : 'Mismatch';
        inventoryComparisonRows.push({
          SKU: avRow[mapping[s.keyFields[0].field].av],
          'Avectous Total Qty': avQty,
          'NS On Hand': nsRow ? nsQty : 0,
          Status: status,
          'Discrepancy (NS - Avectous)': nsRow ? (nsQty - avQty) : (0 - avQty),
          'Open receipts': isOpen ? 'Yes' : 'No'
        });
      }
    }
  }

  return {
    totalNs: nsIndex.size, totalAv: avIndex.size, totalMissing: missingRows.length,
    matchedCount: matched.length,
    missingRows, missingLabel, discrepancies, lineComparison,
    excludedKeyFields: excludedKeyFields.map(f=>f.label),
    excludedCompareFields: excludedCompareFields.map(f=>f.label),
    orderAudit, latestNsDate, syncLag, inventoryStats, inventoryComparisonRows,
    openReceiptsRaw: supplementaryData ? supplementaryData : null
  };
}

/* ===========================================================
   ORDER STATUS — 810 TEXAS DC
   A standalone tab, not a NetSuite-vs-second-system comparison.
   Two NetSuite exports, counted into three states per order.

   Two counting rules matter here, and both were wrong in the
   original spec:

   1. COUNT DISTINCT ORDERS, NOT ROWS. These searches return one
      row per fulfillment status per order, so a partially shipped
      order produces two rows — one "Fulfilled", one "Unfulfilled".
      Counting rows puts that single order in both buckets.

   2. KEY ON INTERNAL ID, NOT PO/CHECK NUMBER. Replacement orders
      inherit the original order's Shopify number, so PO/Check
      Number is not unique and undercounts. Internal ID is the
      only guaranteed-unique key on a NetSuite transaction.

   Hence three states, not two: an order is "Fully shipped" only
   if every one of its rows says Fulfilled; "Not started" only if
   every row says Unfulfilled; "Partial" if it has both.
=========================================================== */
// Orders in a cancellation state are not warehouse work and not sync
// failures — CX is actively trying to stop them. Counting them as backlog
// blames the warehouse for orders nobody wants shipped, and counting them
// as missing from Avectous flags a queue fault where none exists.
//
//   Pending Cancellation   — CX has asked Avectous to cancel
//   Cancellation Confirmed — Avectous agreed it can be cancelled
//   Cancellation Failed    — Avectous could not cancel it
//   Closed (NetSuite)      — cancelled outright
//
// Excluded everywhere, and always reported as a count so the exclusion is
// visible rather than silently shrinking the totals.
const CANCELLED_WMS_STATUSES = ['Pending Cancellation','Cancellation Confirmed','Cancellation Failed'];
const CANCELLED_NS_STATUSES  = ['Closed'];

function isCancelled(wmsValue, statusValue){
  const w = norm(wmsValue), t = norm(statusValue);
  return CANCELLED_WMS_STATUSES.some(x => norm(x) === w) ||
         CANCELLED_NS_STATUSES.some(x => norm(x) === t);
}

const ORDER_STATUS = {
  id:'order_status',
  title:'Order Status — 810 Texas DC',
  so:{
    label:'Fulfillable Sales Orders',
    filePrefix:'BYLTFulfillableSalesOrdersResults',
    savedSearch:'customsearch_fulfillable_orders_final',
    url:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?searchid=4866&saverun=T&whence=',
    keyField:['Internal ID','PO/Check Number'],
    statusField:['Fulfillment Status','Status'],
    dateField:['Date'],
    channelField:['Order Type','Channel'],
    fulfilledDateField:['Date Fulfilled'],
    docField:['PO/Check Number'],
    shipByField:['Ship Date','Ship by Date']
  },
  to:{
    label:'Fulfillable Transfer Orders',
    filePrefix:'BYLTFulfillableTransferOrdersResults',
    savedSearch:'customsearchfulfillable_to_final',
    url:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?searchid=4867&saverun=T&whence=',
    keyField:['Internal ID','Document Number'],
    statusField:['Fulfillment Status','Status'],
    dateField:['Date'],
    channelField:['Channel','To Location'],
    fulfilledDateField:['Date Fulfilled'],
    docField:['Document Number'],
    shipByField:['Ship Date','Ship by Date']
  },
  fulfilledValue:'Fulfilled',
  unfulfilledValue:'Unfulfilled'
};

// Normalises a date cell to YYYY-MM-DD, or null if it isn't a real date.
// NetSuite writes "None" into empty date columns rather than leaving them blank.
function isoDay(raw){
  if(raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if(!str || norm(str) === 'none') return null;
  const d = parseDateRobust(raw);
  if(!d || isNaN(d.getTime()) || d.getFullYear() < 2000) return null;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

// Groups rows by order and assigns each order exactly one state.
//
// A partially shipped order counts as SHIPPED. Something physically left the
// building, and the outstanding items become a customer-service follow-up
// rather than warehouse work in progress. The partial count is still reported
// separately so it never disappears.
//
// Returns per-order detail as well as counts, so every number on screen can be
// exported back to the exact orders that produced it.
function computeOrderStatusSide(data, cfg){
  if(!data || !data.rows || !data.rows.length) return null;

  const keyCol    = guessColumn(data.headers, cfg.keyField);
  const statusCol = guessColumn(data.headers, cfg.statusField);
  const dateCol   = guessColumn(data.headers, cfg.dateField);
  const chanCol   = guessColumn(data.headers, cfg.channelField);
  const fulDateCol= guessColumn(data.headers, cfg.fulfilledDateField);
  const docCol    = guessColumn(data.headers, cfg.docField);
  const wmsCol    = guessColumn(data.headers, ['WMS Status']);
  const nsStCol   = guessColumn(data.headers, ['Status']);
  const shipByCol = guessColumn(data.headers, cfg.shipByField);

  if(!keyCol || !statusCol){
    return {
      error:`Could not find the columns needed. Looked for a key like "${[].concat(cfg.keyField).join('" or "')}" and a status like "${[].concat(cfg.statusField).join('" or "')}". Columns found: ${data.headers.join(', ')}`
    };
  }

  const F = norm(ORDER_STATUS.fulfilledValue);
  const U = norm(ORDER_STATUS.unfulfilledValue);
  const BLANK = '- None -';

  const orders = new Map();
  const unrecognised = new Set();

  data.rows.forEach(row=>{
    const key = String(row[keyCol] ?? '').trim();
    if(!key) return;
    let o = orders.get(key);
    if(!o){
      o = { f:false, u:false, rows:0, orderDay:null, shipByDay:null, fulfilledDay:null, channel:null, doc:null, cancelled:false };
      orders.set(key, o);
    }
    if(!o.cancelled && isCancelled(wmsCol ? row[wmsCol] : '', nsStCol ? row[nsStCol] : '')){
      o.cancelled = true;
    }
    o.rows++;

    const st = norm(row[statusCol]);
    if(st === F){
      o.f = true;
      if(fulDateCol){
        const fd = isoDay(row[fulDateCol]);
        if(fd && (!o.fulfilledDay || fd > o.fulfilledDay)) o.fulfilledDay = fd;
      }
    }
    else if(st === U) o.u = true;
    else if(st) unrecognised.add(String(row[statusCol]).trim());

    if(dateCol && !o.orderDay) o.orderDay = isoDay(row[dateCol]);
    if(shipByCol && !o.shipByDay) o.shipByDay = isoDay(row[shipByCol]);
    if(docCol && !o.doc){
      const dv = String(row[docCol] ?? '').trim();
      if(dv) o.doc = dv;
    }
    if(chanCol && (!o.channel || o.channel === BLANK)){
      const c = String(row[chanCol] ?? '').trim();
      if(c) o.channel = c;
    }
  });

  const todayIso = isoToday();
  const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 86400000);

  // Which day an order belongs to on the backlog view.
  //
  // Ship Date rather than order date, because a prebook placed in March with
  // an August ship date is due in August, not five months overdue.
  //
  // But floored at the order date: a replacement order inherits the original's
  // ship date, so an order created on the 21st can carry a ship date of the
  // 8th. Left alone that would show as two weeks late the moment CX creates
  // it, and would dirty days that are otherwise clean.
  const dueDay = o => {
    if(!o.shipByDay) return o.orderDay;
    if(!o.orderDay) return o.shipByDay;
    return o.shipByDay > o.orderDay ? o.shipByDay : o.orderDay;
  };

  let shipped = 0, notShipped = 0, partial = 0, unknown = 0, cancelled = 0;
  const byDueDay = {};
  const byChannel = {};
  const byOrderDay = {};
  const byFulfilledDay = {};
  const slaDays = [];
  const ageDays = [];
  const ledger = [];

  orders.forEach((o, key)=>{
    if(o.cancelled){
      cancelled++;
      ledger.push([key, o.doc || '', o.orderDay || '', o.fulfilledDay || '',
                   o.channel || BLANK, 'cancelled', 0, null, null, o.rows]);
      return;
    }
    let state;
    if(o.f){ state = 'shipped'; shipped++; if(o.u) partial++; }
    else if(o.u){ state = 'notShipped'; notShipped++; }
    else { state = 'unknown'; unknown++; }

    const ch = o.channel || BLANK;
    if(!byChannel[ch]) byChannel[ch] = { shipped:0, partial:0, notShipped:0, total:0 };
    byChannel[ch].total++;
    if(state === 'shipped'){ byChannel[ch].shipped++; if(o.u) byChannel[ch].partial++; }
    else if(state === 'notShipped') byChannel[ch].notShipped++;

    if(o.orderDay){
      if(!byOrderDay[o.orderDay]) byOrderDay[o.orderDay] = { shipped:0, open:0 };
      if(state === 'shipped') byOrderDay[o.orderDay].shipped++;
      else byOrderDay[o.orderDay].open++;
    }
    const due = dueDay(o);
    if(due){
      if(!byDueDay[due]) byDueDay[due] = { total:0, shipped:0, open:0 };
      byDueDay[due].total++;
      if(state === 'shipped') byDueDay[due].shipped++;
      else byDueDay[due].open++;
    }
    if(o.fulfilledDay) byFulfilledDay[o.fulfilledDay] = (byFulfilledDay[o.fulfilledDay] || 0) + 1;

    // SLA is measured, not promised: neither saved search carries a due date,
    // so the only honest measure is how long the warehouse actually took.
    let sla = null, age = null;
    if(state === 'shipped' && o.orderDay && o.fulfilledDay){
      sla = dayDiff(o.orderDay, o.fulfilledDay);
      if(sla >= 0) slaDays.push(sla); else sla = null;
    }
    if(state === 'notShipped' && o.orderDay){
      age = dayDiff(o.orderDay, todayIso);
      if(age >= 0) ageDays.push(age); else age = null;
    }

    ledger.push([
      key, o.doc || '', o.orderDay || '', o.fulfilledDay || '',
      ch, state, o.u && o.f ? 1 : 0, sla, age, o.rows
    ]);
  });

  slaDays.sort((a,b)=>a-b);
  ageDays.sort((a,b)=>a-b);

  return {
    keyColumn: keyCol,
    statusColumn: statusCol,
    channelColumn: chanCol || null,
    dateColumn: dateCol || null,
    fulfilledDateColumn: fulDateCol || null,
    totalRows: data.rows.length,
    totalOrders: orders.size - cancelled,
    ordersInFile: orders.size,
    cancelled,
    shipped, notShipped, partial, unknown,
    byChannel, byOrderDay, byFulfilledDay,
    backlog: backlogSummary(byDueDay),
    shipByColumn: shipByCol || null,
    sla: summariseDays(slaDays, SLA_BUCKETS),
    age: summariseDays(ageDays, AGE_BUCKETS),
    ledger,
    duplicateRowCount: data.rows.length - orders.size,
    unrecognisedStatuses: [...unrecognised].slice(0, 20),
    reconciles: (shipped + notShipped + unknown + cancelled) === orders.size
  };
}

// Turns the per-day map into phase bands plus the boundaries that matter.
//
// Every unshifted order appears somewhere: the recent window gets its own
// bands, and everything older is folded into a single "Older" band rather
// than a footnote, so the bands always total the card above.
function backlogSummary(byDueDay){
  const today = isoToday();
  const days = Object.keys(byDueDay).filter(d => d <= today).sort();
  const futureKeys = Object.keys(byDueDay).filter(d => d > today);
  const future     = futureKeys.reduce((n,d)=> n + byDueDay[d].total, 0);
  const futureOpen = futureKeys.reduce((n,d)=> n + byDueDay[d].open, 0);
  if(!days.length){
    return { days:[], bands:[], caughtUpThrough:null, nothingSince:null,
             future:0, totalOpen:0, totalOrders:0, totalPct:0,
             totalOpenAll:0, totalPctAll:0 };
  }

  const series = days.map(d=>({
    day: d,
    total: byDueDay[d].total,
    shipped: byDueDay[d].shipped,
    open: byDueDay[d].open,
    pct: byDueDay[d].total ? (byDueDay[d].shipped / byDueDay[d].total) * 100 : 0
  }));

  // Boundary detection ignores tiny days: a 2-order day at 0% shouldn't
  // decide where the warehouse has got to.
  const MIN_VOLUME = 50;
  const solid = series.filter(s => s.total >= MIN_VOLUME);

  // 93 rather than 95, because a day sitting at 94% is part of the cleared
  // run in practice and a tighter threshold splits one clean stretch into
  // three bands that read like a problem.
  const CLEARED_PCT = 93;

  let caughtUpThrough = null;
  for(let i = solid.length - 1; i >= 0; i--){
    if(solid[i].pct >= CLEARED_PCT){ caughtUpThrough = solid[i].day; break; }
  }

  let nothingSince = null;
  for(let i = solid.length - 1; i >= 0; i--){
    if(solid[i].pct < 1) nothingSince = solid[i].day;
    else break;
  }

  const WINDOW = 18;
  const shown = series.slice(-WINDOW);
  const older = series.slice(0, Math.max(0, series.length - WINDOW));

  const levelOf = p => p >= CLEARED_PCT ? 'cleared' : p < 1 ? 'notstarted' : 'progress';
  const LABELS = { cleared:'Cleared', progress:'Part way through', notstarted:'Not started' };

  const bands = [];
  const push = (level, label, from, to, dayCount, total, shipped, open, muted) => {
    bands.push({ level, label, from, to, dayCount, total, shipped, open, muted:!!muted,
                 pct: total ? (shipped / total) * 100 : 0 });
  };

  if(older.length){
    push('older', 'Older', older[0].day, older[older.length-1].day, older.length,
         older.reduce((n,s)=>n+s.total,0), older.reduce((n,s)=>n+s.shipped,0),
         older.reduce((n,s)=>n+s.open,0), true);
  }

  shown.forEach(d=>{
    const level = levelOf(d.pct);
    const last = bands[bands.length - 1];
    if(last && last.level === level && !last.muted){
      last.to = d.day; last.dayCount++;
      last.total += d.total; last.shipped += d.shipped; last.open += d.open;
      last.pct = last.total ? (last.shipped / last.total) * 100 : 0;
    } else {
      push(level, LABELS[level], d.day, d.day, 1, d.total, d.shipped, d.open);
    }
  });

  const totalOrders = series.reduce((n,s)=>n+s.total,0);
  const totalOpen   = series.reduce((n,s)=>n+s.open,0);

  // Two totals: the bands cover due dates up to today, but the card counts
  // every unshipped order including pre-orders not due yet. The "All orders"
  // row uses the wider figure so it ties to the card exactly.
  const totalOrdersAll = totalOrders + future;
  const totalOpenAll   = totalOpen + futureOpen;

  return {
    days: shown,
    bands,
    caughtUpThrough,
    nothingSince,
    future: futureOpen,
    totalOrders,
    totalOpen,
    totalPct: totalOrders ? ((totalOrders - totalOpen) / totalOrders) * 100 : 0,
    totalOpenAll,
    totalPctAll: totalOrdersAll ? ((totalOrdersAll - totalOpenAll) / totalOrdersAll) * 100 : 0
  };
}

function isoToday(){
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

const SLA_BUCKETS = [
  { label:'Same day', test: d => d <= 0 },
  { label:'1 day',    test: d => d === 1 },
  { label:'2 days',   test: d => d === 2 },
  { label:'3-5 days', test: d => d <= 5 },
  { label:'6-10 days',test: d => d <= 10 },
  { label:'Over 10 days', test: () => true }
];

const AGE_BUCKETS = [
  { label:'0-1 day',  test: d => d <= 1 },
  { label:'2 days',   test: d => d === 2 },
  { label:'3-5 days', test: d => d <= 5 },
  { label:'6-10 days',test: d => d <= 10 },
  { label:'Over 10 days', test: () => true }
];

// Percentiles plus a bucket histogram from an already-sorted array of day counts.
function summariseDays(sorted, buckets){
  if(!sorted.length){
    return { count:0, median:null, p75:null, p90:null, p95:null, worst:null, buckets:[] };
  }
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const counts = buckets.map(()=>0);
  sorted.forEach(d=>{
    for(let i = 0; i < buckets.length; i++){
      if(buckets[i].test(d)){ counts[i]++; break; }
    }
  });
  return {
    count: sorted.length,
    median: at(0.5), p75: at(0.75), p90: at(0.9), p95: at(0.95),
    worst: sorted[sorted.length - 1],
    buckets: buckets.map((b, i)=>({ label:b.label, count:counts[i] })).filter(b=>b.count > 0)
  };
}

// How many orders are still waiting beyond the point where most already shipped.
// Uses the 90th percentile of actual ship time as the line, so the threshold
// comes from the warehouse's own performance rather than an arbitrary number.
function beyondNormal(side){
  if(!side || side.error || !side.sla || side.sla.median === null) return null;
  const line = side.sla.p90;
  const over = side.ledger.filter(r => r[5] === 'notShipped' && r[8] !== null && r[8] > line).length;
  return { line, over };
}

// Merges the two sides' per-day maps into one sorted series.
function mergeDaySeries(a, b, fields){
  const out = {};
  [a, b].forEach(src=>{
    if(!src) return;
    Object.keys(src).forEach(day=>{
      if(!out[day]){ out[day] = {}; fields.forEach(f => out[day][f] = 0); }
      fields.forEach(f=>{
        const v = typeof src[day] === 'number' ? src[day] : (src[day][f] || 0);
        out[day][f] += v;
      });
    });
  });
  return out;
}

function computeOrderStatus(soData, toData){
  const so = computeOrderStatusSide(soData, ORDER_STATUS.so);
  const to = computeOrderStatusSide(toData, ORDER_STATUS.to);

  const sum = (a, b, f) => {
    const x = (a && !a.error) ? a[f] : 0;
    const y = (b && !b.error) ? b[f] : 0;
    return x + y;
  };

  const soOk = so && !so.error ? so : null;
  const toOk = to && !to.error ? to : null;

  return {
    so, to,
    total:{
      totalOrders: sum(so, to, 'totalOrders'),
      totalRows:   sum(so, to, 'totalRows'),
      cancelled:   sum(so, to, 'cancelled'),
      shipped:     sum(so, to, 'shipped'),
      partial:     sum(so, to, 'partial'),
      notShipped:  sum(so, to, 'notShipped'),
      unknown:     sum(so, to, 'unknown')
    },
    backlog: mergeDaySeries(
      soOk && soOk.byOrderDay,
      toOk && toOk.byOrderDay,
      ['shipped','open']
    ),
    beyondNormal: {
      so: beyondNormal(soOk),
      to: beyondNormal(toOk)
    },
    computedAt: isoToday()
  };
}

// Shared save path used by both the Order Status tab and Load Data.
async function syncSectionToShared(sectionId, result, ranBy){
  saveSectionResult(sectionId, result, ranBy);
  try{
    const res = await fetch('/api/data', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ sectionId, result, ranBy: ranBy || null })
    });
    if(!res.ok){
      const body = await res.json().catch(()=>({}));
      return { ok:false, error: body.error || `Server returned ${res.status}` };
    }
    return { ok:true };
  } catch(err){
    return { ok:false, error: err.message };
  }
}

/* ===========================================================
   INTEGRATIONS STATUS
   Audits the order queues between NetSuite and Avectous.

   DIRECTION MATTERS, and it is different for the two halves:

   - ORDER SYNC runs NetSuite -> Avectous. NetSuite creates the
     order, the queue pushes it out. So the question is: of the
     orders NetSuite has, how many reached Avectous?

   - FULFILLMENT SYNC runs Avectous -> NetSuite. The warehouse
     physically ships, then confirms back. So the question is the
     reverse: of the orders Avectous shipped, how many did
     NetSuite record?

   Scoping the fulfillment check to orders NetSuite already
   fulfilled reads ~99% and is meaningless — an order NetSuite
   never fulfilled cannot appear in that sample, so every real
   failure is excluded by construction.

   Avectous puts sales orders and transfer orders in one export,
   so each NetSuite search is matched against the whole file
   rather than trusting the OrderType column.
=========================================================== */
const INTEGRATIONS = {
  id:'integrations',
  queueMinutes:15,
  sources:{
    so:{ label:'Fulfillable Sales Orders', search:'4866',
         url:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?searchid=4866&saverun=T&whence=',
         keyField:['PO/Check Number'], hint:'BYLTFulfillableSalesOrdersResults' },
    to:{ label:'Fulfillable Transfer Orders', search:'4867',
         url:'https://11170298.app.netsuite.com/app/common/search/savedsearchresults.nl?searchid=4867&saverun=T&whence=',
         keyField:['Document Number'], hint:'BYLTFulfillableTransferOrdersResults' },
    sync:{ label:'Avectous Orders', hint:'Orders(...).xlsx — the order download',
           keyField:['OrderNumber'] },
    ship:{ label:'Avectous Shipments', hint:'Orders(...).xlsx — the shipments report',
           keyField:['OrderNumber'], dateField:['LastShipDate'] }
  }
};

// Collapses a NetSuite export to one entry per order.
function nsOrderIndex(data, keyField){
  const keyCol = guessColumn(data.headers, keyField);
  const idCol  = guessColumn(data.headers, ['Internal ID']);
  const stCol  = guessColumn(data.headers, ['Fulfillment Status']);
  const dtCol  = guessColumn(data.headers, ['Date']);
  const statusCol = guessColumn(data.headers, ['Status']);
  const wmsCol = guessColumn(data.headers, ['WMS Status']);
  const typeCol = guessColumn(data.headers, ['Order Type']);
  if(!keyCol || !stCol) return { error:`Could not find the columns needed. Looked for "${[].concat(keyField).join('" or "')}" and "Fulfillment Status". Found: ${data.headers.join(', ')}` };

  const byKey = new Map();
  data.rows.forEach(row=>{
    const k = String(row[keyCol] ?? '').trim();
    if(!k) return;
    let o = byKey.get(k);
    if(!o){
      o = { key:k, id: idCol ? String(row[idCol] ?? '').trim() : '', fulfilled:false,
            orderDay: dtCol ? isoDay(row[dtCol]) : null,
            status: statusCol ? String(row[statusCol] ?? '').trim() : '',
            wms: wmsCol ? String(row[wmsCol] ?? '').trim() : '',
            type: typeCol ? String(row[typeCol] ?? '').trim() : '',
            cancelled:false };
      byKey.set(k, o);
    }
    if(!o.cancelled && isCancelled(wmsCol ? row[wmsCol] : '', statusCol ? row[statusCol] : '')){
      o.cancelled = true;
    }
    if(norm(row[stCol]) === norm('Fulfilled')) o.fulfilled = true;
  });
  return { byKey, keyColumn:keyCol };
}

// Collapses an Avectous export to one entry per order number.
function avOrderIndex(data, cfg){
  const keyCol = guessColumn(data.headers, cfg.keyField);
  const dateCol = cfg.dateField ? guessColumn(data.headers, cfg.dateField) : null;
  const typeCol = guessColumn(data.headers, ['OrderType']);
  const statCol = guessColumn(data.headers, ['Status']);
  const chanCol = guessColumn(data.headers, ['Channel']);
  if(!keyCol) return { error:`Could not find an "${[].concat(cfg.keyField).join('" or "')}" column. Found: ${data.headers.join(', ')}` };

  const byKey = new Map();
  data.rows.forEach(row=>{
    const k = String(row[keyCol] ?? '').trim();
    if(!k) return;
    const day = dateCol ? isoDay(row[dateCol]) : null;
    let o = byKey.get(k);
    if(!o){
      o = { key:k, day,
            type: typeCol ? String(row[typeCol] ?? '').trim() : '',
            status: statCol ? String(row[statCol] ?? '').trim() : '',
            channel: chanCol ? String(row[chanCol] ?? '').trim() : '' };
      byKey.set(k, o);
    } else if(day && (!o.day || day > o.day)){
      o.day = day;
    }
  });
  return { byKey, keyColumn:keyCol, latestDay: [...byKey.values()].reduce((a,o)=> (o.day && (!a || o.day > a)) ? o.day : a, null) };
}

function pctOf(part, whole){ return whole > 0 ? (part / whole) * 100 : null; }

function computeIntegrations(soData, toData, syncData, shipData){
  const ns = {
    so: soData ? nsOrderIndex(soData, INTEGRATIONS.sources.so.keyField) : null,
    to: toData ? nsOrderIndex(toData, INTEGRATIONS.sources.to.keyField) : null
  };
  const av = {
    sync: syncData ? avOrderIndex(syncData, INTEGRATIONS.sources.sync) : null,
    ship: shipData ? avOrderIndex(shipData, INTEGRATIONS.sources.ship) : null
  };
  const err = [ns.so, ns.to, av.sync, av.ship].find(x => x && x.error);
  if(err) return { error: err.error };
  if(!ns.so || !ns.to || !av.sync || !av.ship) return { error:'All four files are needed.' };

  const today = av.ship.latestDay || isoToday();

  // NetSuite -> Avectous. Every order NetSuite holds should be in the download.
  function syncAudit(nsSide, label){
    const missing = [], cancelledRows = [];
    let matched = 0, total = 0;
    nsSide.byKey.forEach(o=>{
      // A cancelled order is not a sync failure — CX is trying to stop it.
      if(o.cancelled){
        cancelledRows.push([o.key, o.id, o.orderDay || '', o.type, o.status, o.wms]);
        return;
      }
      total++;
      if(av.sync.byKey.has(o.key)) matched++;
      else missing.push([o.key, o.id, o.orderDay || '', o.type, o.status, o.wms]);
    });
    missing.sort((a,b)=> String(a[2]).localeCompare(String(b[2])));
    return { label, direction:'NetSuite \u2192 Avectous', total, matched,
             missing: missing.length, cancelled: cancelledRows.length, cancelledRows,
             health: pctOf(matched, total), rows: missing };
  }

  // Avectous -> NetSuite. Every order Avectous shipped should have a
  // fulfillment in NetSuite. Anything shipped before today has had far
  // longer than the queue interval to arrive.
  function fulfilAudit(nsSide, label){
    const missing = [], cancelledRows = [], noShipRecord = [];
    let shipped = 0, recorded = 0, sameDay = 0;
    nsSide.byKey.forEach(o=>{
      const a = av.ship.byKey.get(o.key);
      if(!a){
        // NetSuite created a fulfillment but Avectous has no shipment for it.
        // The mirror of the main failure: either someone fulfilled by hand in
        // NetSuite without the warehouse shipping, or Avectous shipped it and
        // lost the record. Reported separately, never inside queue health,
        // because the denominator here is what Avectous shipped.
        if(o.fulfilled && !o.cancelled){
          noShipRecord.push([o.key, o.id, o.orderDay || '', o.status, o.wms, o.type]);
        }
        return;
      }
      if(o.cancelled){
        cancelledRows.push([o.key, o.id, a.day || '', o.orderDay || '', o.status, o.wms, 'Cancelled']);
        return;
      }
      shipped++;
      if(o.fulfilled){ recorded++; return; }
      const isToday = a.day && a.day >= today;
      if(isToday) sameDay++;
      missing.push([o.key, o.id, a.day || '', o.orderDay || '', o.status, o.wms, isToday ? 'Today' : 'Overdue']);
    });
    missing.sort((a,b)=> String(a[2]).localeCompare(String(b[2])));
    noShipRecord.sort((a,b)=> String(a[2]).localeCompare(String(b[2])));
    return { label, direction:'Avectous \u2192 NetSuite', total: shipped, matched: recorded,
             missing: missing.length, overdue: missing.length - sameDay, sameDay,
             cancelled: cancelledRows.length, cancelledRows,
             noShipRecord: noShipRecord.length, noShipRecordRows: noShipRecord,
             health: pctOf(recorded, shipped), rows: missing };
  }

  // Anything Avectous holds that neither NetSuite search knows about.
  // Two very different things end up here and they need separating:
  //
  //   TEST      — an order number containing TEST. Avectous's own test data,
  //               which should never have reached a production warehouse.
  //   NEWER     — a real order created after the NetSuite export was pulled.
  //               Avectous is working it correctly; the NetSuite snapshot is
  //               simply older. Not a fault in either system.
  //
  // Lumping them together makes test pollution invisible behind a timing
  // artefact, so each is counted and exported on its own.
  const nsKeys = new Set([...ns.so.byKey.keys(), ...ns.to.byKey.keys()]);
  const isTestOrder = k => /test/i.test(k);
  const orphans = { sync: [], ship: [], tests: [], newer: [] };

  function classifyOrphan(o, source){
    const row = [o.key, o.day || '', o.type, o.status, o.channel, source];
    if(isTestOrder(o.key)) orphans.tests.push(row);
    else orphans.newer.push(row);
    return row;
  }
  av.sync.byKey.forEach(o=>{ if(!nsKeys.has(o.key)) orphans.sync.push(classifyOrphan(o, 'Order download')); });
  av.ship.byKey.forEach(o=>{ if(!nsKeys.has(o.key)) orphans.ship.push(classifyOrphan(o, 'Shipments')); });

  return {
    computedAt: new Date().toISOString(),
    avectousThrough: today,
    audits:{
      soSync:   syncAudit(ns.so, 'Sales order sync'),
      toSync:   syncAudit(ns.to, 'Transfer order sync'),
      soFulfil: fulfilAudit(ns.so, 'Sales order fulfillments'),
      toFulfil: fulfilAudit(ns.to, 'Transfer order fulfillments')
    },
    orphans,
    counts:{
      nsSo: ns.so.byKey.size, nsTo: ns.to.byKey.size,
      avSync: av.sync.byKey.size, avShip: av.ship.byKey.size
    }
  };
}
