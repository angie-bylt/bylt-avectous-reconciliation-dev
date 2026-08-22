/* ===========================================================
   INTEGRATIONS COMPARISON EXPORT

   One workbook that serves two readers:
     - Chris, who wants the headline health of each queue
     - Avectous, who need the specific order numbers to chase

   Sheet 1 is the summary. Sheet 2 explains the method, including
   why the two halves are measured in opposite directions. The
   remaining sheets are one row per problem order, filterable.
=========================================================== */
(function(){
  const SYNC_HEADERS   = ['Order Number','NetSuite Internal ID','Order Date','Order Type','NetSuite Status','WMS Status'];
  const FULFIL_HEADERS = ['Order Number','NetSuite Internal ID','Avectous Ship Date','Order Date','NetSuite Status','WMS Status','Age'];
  const ORPHAN_HEADERS = ['Order Number','Date','Order Type','Status','Channel','Found in','Kind'];

  function sheet(headers, rows){
    const s = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    s['!cols'] = headers.map(h => ({ wch: Math.max(12, Math.min(24, h.length + 4)) }));
    if(rows.length){
      s['!autofilter'] = { ref: XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:rows.length, c:headers.length-1} }) };
    }
    s['!freeze'] = { xSplit:0, ySplit:1 };
    return s;
  }

  function add(wb, name, sh){
    // Excel caps sheet names at 31 characters and rejects several symbols.
    XLSX.utils.book_append_sheet(wb, sh, name.replace(/[\\\/\?\*\[\]:]/g,'-').slice(0,31));
  }

  window.exportComparison = function exportComparison(){
    if(!current) return;
    const btn = document.getElementById('exportBtn');
    const original = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Building…';

    try{
      const wb = XLSX.utils.book_new();
      const a = current.audits, c = current.counts;
      const stamp = savedAt ? new Date(savedAt).toLocaleString() : new Date().toLocaleString();
      const pctText = v => v === null ? '—' : (v.toFixed(2) + '%');

      const S = [];
      const push = (...r) => S.push(r.map(x => x === undefined ? '' : x));

      push('NETSUITE / AVECTOUS — INTEGRATION QUEUE STATUS');
      push('Figures as at', stamp);
      push('Prepared by', ranBy || '');
      push('Avectous data through', current.avectousThrough || '');
      push();
      push('QUEUE', 'DIRECTION', 'EXPECTED', 'ARRIVED', 'MISSING', 'HEALTH');
      [['soSync',false],['toSync',false],['soFulfil',true],['toFulfil',true]].forEach(([k,isF])=>{
        const x = a[k];
        push(x.label, x.direction, x.total, x.matched, x.missing, pctText(x.health));
      });
      push();
      push('OVERDUE BREAKDOWN', '', 'Shipped today', 'Overdue', '', 'Sheet');
      push(a.soFulfil.label, '', a.soFulfil.sameDay, a.soFulfil.overdue, '', 'SO Fulfillments Missing');
      push(a.toFulfil.label, '', a.toFulfil.sameDay, a.toFulfil.overdue, '', 'TO Fulfillments Missing');
      push();
      push('THE OPPOSITE FAILURE', '', 'Orders', '', '', 'Sheet');
      push('Fulfilled in NetSuite, no Avectous shipment', '',
           (a.soFulfil.noShipRecord || 0) + (a.toFulfil.noShipRecord || 0), '', '', 'Fulfilled No AV Shipment');
      push('', 'Either fulfilled by hand in NetSuite without the warehouse shipping, or Avectous shipped it and lost the record. Not included in queue health, because the denominator there is what Avectous shipped.');
      push();
      push('WHAT TO LOOK AT FIRST');
      if(a.soFulfil.overdue || a.toFulfil.overdue){
        push('', (a.soFulfil.overdue + a.toFulfil.overdue).toLocaleString() +
          ' orders were shipped by Avectous on an earlier day and still have no fulfillment in NetSuite.');
        push('', 'The queue runs every 15 minutes, so these have had far longer than one cycle. Order numbers are on the two "Fulfillments Missing" sheets.');
      } else {
        push('', 'No overdue fulfillments. Every order Avectous shipped before today is recorded in NetSuite.');
      }
      push();
      push('SOURCE FILE SIZES', '', 'Orders');
      push('NetSuite sales orders (4866)', '', c.nsSo);
      push('NetSuite transfer orders (4867)', '', c.nsTo);
      push('Avectous orders', '', c.avSync);
      push('Avectous shipments', '', c.avShip);
      push('In Avectous only, no NetSuite match', '', current.orphans.sync.length + current.orphans.ship.length,
           '', '', 'Excluded from every percentage above');
      push('  of which Avectous test orders', '', current.orphans.tests.length, '', '',
           'Order numbers containing TEST - should not be in a production warehouse');
      push('  of which created after the NetSuite pull', '', current.orphans.newer.length, '', '',
           'Real orders Avectous is working. Timing, not a fault.');
      const cancelledTotal = ['soSync','toSync','soFulfil','toFulfil'].reduce((n,k)=> n + (a[k].cancelled || 0), 0);
      push('Cancelled, excluded', '', cancelledTotal, '', '', 'See the Cancelled Excluded sheet');

      const sum = XLSX.utils.aoa_to_sheet(S);
      sum['!cols'] = [{wch:36},{wch:22},{wch:14},{wch:12},{wch:11},{wch:30}];
      add(wb, 'Summary', sum);

      const M = [];
      const m = (...r) => M.push(r.map(x => x === undefined ? '' : x));
      m('METHOD');
      m();
      m('Direction is different for the two halves, and it matters.');
      m();
      m('Order sync', 'NetSuite \u2192 Avectous');
      m('', 'NetSuite creates the order and the queue pushes it out, so the test is: of the orders NetSuite holds, how many reached Avectous?');
      m();
      m('Fulfillment sync', 'Avectous \u2192 NetSuite');
      m('', 'The warehouse physically ships, then confirms back. So the test is the reverse: of the orders Avectous shipped, how many did NetSuite record?');
      m('', 'Checking this the other way round - taking orders NetSuite already fulfilled and asking whether Avectous agrees - reads about 99% and means nothing, because an order NetSuite never fulfilled cannot appear in that sample. Every real failure would be excluded by construction.');
      m();
      m('Matching');
      m('', 'Sales orders match on PO/Check Number against the Avectous OrderNumber column.');
      m('', 'Transfer orders match on Document Number against the same column.');
      m('', 'Avectous puts sales orders and transfer orders in one export, so each NetSuite search is matched against the whole file rather than trusting the OrderType column.');
      m('', 'Each order is counted once. NetSuite returns one row per fulfillment status, so a partially shipped order appears twice in the raw export.');
      m();
      m('The 15-minute queue window');
      m('', 'Anything Avectous shipped on its most recent day is reported as "shipped today" rather than counted as a failure. Everything older is overdue.');
      m();
      m('Fulfilled in NetSuite, no Avectous shipment');
      m('', 'The mirror of the main failure. NetSuite has an Item Fulfillment but the Avectous shipments report has no record of the order at all.');
      m('', 'Reported separately and never inside queue health, because the denominator there is what Avectous shipped - an order Avectous has no record of cannot belong in it.');
      m('', 'These need chasing from the NetSuite end. Check whether the fulfillment was created manually, and whether WMS Status was ever updated.');
      m();
      m('Cancelled orders');
      m('', 'Excluded from every percentage. An order is treated as cancelled when its WMS Status is Pending Cancellation, Cancellation Confirmed or Cancellation Failed, or when its NetSuite Status is Closed.');
      m('', 'CX is actively trying to stop these orders, so a missing sync is not a queue fault and an unshipped order is not warehouse backlog. They are listed on the Cancelled Excluded sheet so nothing is hidden.');
      m();
      m('Orders only Avectous has');
      m('', 'Never included in a health percentage. Two different things end up here, so the Kind column separates them:');
      m('', 'Avectous test order - the order number contains TEST. These should not exist in a production warehouse.');
      m('', 'Created after the NetSuite pull - a real order Avectous is working correctly. The NetSuite snapshot is simply older. Not a fault in either system.');
      m();
      m('How to verify any figure');
      m('1', 'Open a detail sheet. Every row is one order, and the order number never repeats.');
      m('2', 'Filter Age to Overdue to see only orders past the queue window.');
      m('3', 'Take any order number to NetSuite and check whether an Item Fulfillment exists.');
      const meth = XLSX.utils.aoa_to_sheet(M);
      meth['!cols'] = [{wch:22},{wch:120}];
      add(wb, 'Method', meth);

      add(wb, 'SO Sync Missing',         sheet(SYNC_HEADERS,   a.soSync.rows));
      add(wb, 'TO Sync Missing',         sheet(SYNC_HEADERS,   a.toSync.rows));
      add(wb, 'SO Fulfillments Missing', sheet(FULFIL_HEADERS, a.soFulfil.rows));
      add(wb, 'TO Fulfillments Missing', sheet(FULFIL_HEADERS, a.toFulfil.rows));
      const testSet = new Set(current.orphans.tests.map(r => r[0]));
      const orphanRows = current.orphans.sync.concat(current.orphans.ship)
        .map(r => r.concat([ testSet.has(r[0]) ? 'Avectous test order' : 'Created after the NetSuite pull' ]));
      add(wb, 'In Avectous Only', sheet(ORPHAN_HEADERS, orphanRows));

      // Cancelled orders, deduplicated across the four audits.
      const seenC = new Set(); const cancelledRows = [];
      [['soSync','Sales order'],['toSync','Transfer order'],['soFulfil','Sales order'],['toFulfil','Transfer order']].forEach(([k,type])=>{
        (a[k].cancelledRows || []).forEach(r=>{
          if(seenC.has(r[0])) return;
          seenC.add(r[0]);
          cancelledRows.push([r[0], r[1], type, r[2] || '', r[4] || '', r[5] || '']);
        });
      });
      const noShipRows = []
        .concat((a.soFulfil.noShipRecordRows || []).map(r => r.concat(['Sales order'])))
        .concat((a.toFulfil.noShipRecordRows || []).map(r => r.concat(['Transfer order'])));
      add(wb, 'Fulfilled No AV Shipment',
        sheet(['Order Number','NetSuite Internal ID','Order Date','NetSuite Status','WMS Status','Order Type','Record'], noShipRows));

      add(wb, 'Cancelled Excluded',
        sheet(['Order Number','NetSuite Internal ID','Order Type','Date','NetSuite Status','WMS Status'], cancelledRows));

      const d = new Date();
      const pad = n => String(n).padStart(2,'0');
      XLSX.writeFile(wb, `BYLT_Integration_Queue_Status_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}.xlsx`);
    } catch(err){
      alert('Could not build the export: ' + err.message);
    } finally {
      btn.disabled = false; btn.innerHTML = original;
    }
  };
})();
