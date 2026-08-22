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
  const ORPHAN_HEADERS = ['Order Number','Date','Order Type','Status','Channel'];

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
      m('Orders only Avectous has');
      m('', 'Listed on their own sheets and never included in a health percentage. Usually test orders, or orders created after the NetSuite export was pulled.');
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
      add(wb, 'In Avectous Only',        sheet(ORPHAN_HEADERS, current.orphans.sync.concat(current.orphans.ship)));

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
