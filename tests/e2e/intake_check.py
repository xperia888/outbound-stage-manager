"""Click-through checks for intake.html (Order Intake portal) against the real Code.gs on an
in-memory sheet. Seeds a staging board so floor progress shows, then: CS sign-in, new order,
edit, cancel/restore, CSV and Excel import with column matching, WMS API push, API page,
phone layout. Screenshots go to out/intake_*.png. Exit code 1 if any check fails."""
import asyncio, functools, http.server, threading, json, subprocess, time, urllib.request, os, sys
from playwright.async_api import async_playwright
import openpyxl

E2E = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.abspath(os.path.join(E2E, '..', '..'))
OUT = os.path.join(E2E, 'out'); os.makedirs(OUT, exist_ok=True)
GAS_PORT, SITE_PORT = 8791, 8771
now = int(time.time() * 1000)
results = []

def record(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'  → {detail}'))

gas = subprocess.Popen(['node', E2E + '/fake-apps-script.mjs', REPO + '/Code.gs', str(GAS_PORT)], stdout=subprocess.PIPE)
gas.stdout.readline()
def req(body):
    return json.loads(urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{GAS_PORT}/exec', data=json.dumps(body).encode(), method='POST')).read())
def dump():
    return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{GAS_PORT}/dump').read())['sheets']

# Staging board with pallets for DN-E2E-1 (4 on floor, 2 at DOCK-03) and DN-OLD-7 (all shipped)
board = {
    'columns': [{'id': 'c51', 'name': 'S51', 'capacity': 8}, {'id': 'c52', 'name': 'S52', 'capacity': 8}],
    'pallets': [{'id': f'p{i}', 'slp': f'DN-E2E-1-0{i}', 'orderNumber': 'DN-E2E-1', 'columnId': 'c51' if i < 3 else 'c52',
                 'dockNumber': 'DOCK-03' if i < 2 else '', 'createdAt': now - 3600_000} for i in range(4)],
    'shippedPallets': [{'id': f's{i}', 'slp': f'DN-OLD-7-0{i}', 'orderNumber': 'DN-OLD-7', 'shippedAt': now - 600_000} for i in range(3)],
    'docks': ['DOCK-03'], 'carriers': []
}
record('seed board', req({'fn': 'saveBoardState', 'args': [json.dumps(board), ''], 'key': 'ont-e2e', 'warehouse': 'ONT'})['ok'])

# Access rules straight against the server
r = req({'fn': 'loadBoardState', 'key': 'cs-e2e', 'warehouse': 'ONT'})
record('CS code cannot read the staging board', r.get('unauthorized') is True, r)
r = req({'fn': 'resolveWarehouse', 'key': 'wms-e2e'})
record('WMS key is not a sign-in code', r.get('ok') is False, r)

site = http.server.ThreadingHTTPServer(('127.0.0.1', SITE_PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=REPO))
site.RequestHandlerClass.log_message = lambda *a: None
threading.Thread(target=site.serve_forever, daemon=True).start()

# Files a WMS might export (odd column names on purpose)
csv_path = os.path.join(OUT, 'wms_export.csv')
with open(csv_path, 'w', newline='') as f:
    f.write('﻿Delivery No,Ship To Name,Ctns,Plts,ARN,Ship Via,Created Date,Remarks,Picked By,VRID,Order Ready\r\n'
            'dn-imp-1,"Globex, Inc.",120,6,ARN-1001,Saia,11/24/2026 9:15 AM,,Maria,vr-001,11/25/2026\r\n'
            'DN-IMP-2,Initech,80,4,ARN-1002,Estes Express,11/24/2026 10:40 AM,"Call ""before"" pickup",,,\r\n'
            'DN-E2E-1,,,7,,,,,,,\r\n'                      # existing order: only pallets changes
            'DN-IMP-3,Umbrella,ten,2,ARN-1003,UPS,11/24/2026 11:00 AM,,,,\r\n'  # bad cartons
            'DN-IMP-1,Globex,1,1,,,,,,,\r\n'                # duplicate in file
            ',No Number Co,1,1,,,,,,,\r\n')
xlsx_path = os.path.join(OUT, 'wms_export.xlsx')
wb = openpyxl.Workbook(); ws = wb.active
ws.append(['Order Number', 'Customer', 'Cartons', 'Pallets', 'PO', 'Carrier', 'Release Date'])
from datetime import datetime
ws.append(['DN-XL-1', 'Stark Industries', 300, 12, 'PO-77', 'Old Dominion', datetime(2026, 11, 24, 13, 30)])
ws.append(['DN-XL-2', 'Wayne Enterprises', 40, 2, 'PO-78', 'XPO Logistics', datetime(2026, 11, 24, 14, 0)])
wb.save(xlsx_path)

def amazon_report(path, rows):
    wb2 = openpyxl.Workbook()
    summ = wb2.active; summ.title = 'Summary'
    summ.append(['Total orders', len(rows)])
    ws2 = wb2.create_sheet('Orders Export')
    ws2.append(['Outbound report - Nov 24'])
    ws2.append([])
    ws2.append(['Delivery #', 'Account', 'City', 'State', 'Plt Qty', 'Box Qty', 'Load VRID', 'Pick Associate', 'Remark'])
    for r in rows: ws2.append(r)
    wb2.save(path)
amz1 = os.path.join(OUT, 'amazon_report_1.xlsx')
amazon_report(amz1, [['DN-AMZ-1', 'Amazon ONT8', 'Reno', 'NV', 10, 400, '115abc', 'Luis', ''],
                     ['DN-AMZ-2', 'Amazon LGB8', 'Rialto', 'CA', 4, 120, '116def', 'Kim', 'Floor load']])
amz2 = os.path.join(OUT, 'amazon_report_2.xlsx')
amazon_report(amz2, [['DN-AMZ-3', 'Amazon SBD1', 'Bloomington', 'CA', 7, 260, '117ghi', 'Luis', '']])

async def to_gas(route):
    data = route.request.post_data or ''
    resp = await asyncio.to_thread(lambda: urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{GAS_PORT}/exec', data=data.encode(), method='POST')).read())
    await route.fulfill(body=resp, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'})

async def sheetjs(route):
    await route.fulfill(path=os.path.join(E2E, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'), content_type='application/javascript')

def orders_rows():
    rows = dump().get('Orders', [])
    head = rows[0] if rows else []
    return [dict(zip(head, r)) for r in rows[1:]]

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
        await ctx.route('https://script.google.com/**', to_gas)
        await ctx.route('https://cdn.sheetjs.com/**', sheetjs)
        pg = await ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))

        # --- Sign in with the CS code -----------------------------------------------------------
        await pg.goto(f'http://127.0.0.1:{SITE_PORT}/intake.html'); await pg.wait_for_timeout(500)
        record('sign-in shows on a new device', await pg.is_visible('#signin'))
        await pg.fill('#signin-code', 'cs-e2e'); await pg.click('#signin-btn'); await pg.wait_for_timeout(300)
        record('name is required at sign-in', await pg.is_visible('#signin') and 'Enter your name' in (await pg.text_content('#signin-error') or ''))
        await pg.fill('#signin-name', 'Amy')
        await pg.fill('#signin-code', 'wms-e2e'); await pg.click('#signin-btn'); await pg.wait_for_timeout(600)
        record('WMS key rejected at sign-in', 'not recognized' in (await pg.text_content('#signin-error') or ''))
        await pg.fill('#signin-code', 'cs-e2e'); await pg.fill('#signin-name', 'Amy'); await pg.click('#signin-btn')
        await pg.wait_for_timeout(1200)
        record('CS code signs in to ONT', not await pg.is_visible('#signin') and (await pg.text_content('#wh-chip')) == 'ONUS-ONT')
        record('name shown as Entered by', (await pg.text_content('#user-btn')) == 'Amy')

        # --- New order --------------------------------------------------------------------------
        await pg.click('#new-btn'); await pg.wait_for_timeout(200)
        await pg.click('#save-btn'); await pg.wait_for_timeout(200)
        record('form requires Order # and customer', 'required' in (await pg.text_content('#form-error') or ''))
        await pg.fill('#f-orderNumber', 'dn-e2e-1'); await pg.fill('#f-customer', 'Acme Corp')
        await pg.select_option('#f-orderType', 'LTL'); await pg.fill('#f-cartons', '240'); await pg.fill('#f-pallets', '6')
        await pg.select_option('#f-refType', 'ARN#'); await pg.fill('#f-reference', 'ARN-0001')
        await pg.fill('#f-carrier', 'Saia'); await pg.fill('#f-scac', 'saia'); await pg.fill('#f-shipDate', '2026-11-26'); await pg.fill('#f-readyDate', '2026-11-25')
        await pg.fill('#f-destination', 'Phoenix, AZ')
        await pg.fill('#f-picker', 'Jose M.'); await pg.fill('#f-vrid', '115xyz7ab')
        await pg.screenshot(path=f'{OUT}/intake_form.png', full_page=True)
        await pg.click('#save-btn'); await pg.wait_for_timeout(1500)
        rows = orders_rows()
        o = next((x for x in rows if x.get('Order #') == 'DN-E2E-1'), {})
        record('new order saved to the Orders tab', o.get('Customer') == 'Acme Corp' and o.get('Pallets') == 6 and o.get('Reference Type') == 'ARN#'
               and o.get('SCAC') == 'SAIA' and o.get('Entered By') == 'Amy' and o.get('Source') == 'Manual' and o.get('Status') == 'Released'
               and o.get('Picker') == 'Jose M.' and o.get('VRID') == '115XYZ7AB' and o.get('Order Ready Date') == '2026-11-25', o)
        record('release time filled in', bool(o.get('Released to Warehouse')))
        row_text = await pg.text_content('tr[data-order="DN-E2E-1"]') or ''
        record('list shows floor progress from the board (At D3, 4/6)', 'At D3' in row_text and '4/6' in row_text, row_text)
        lane_cell = await pg.evaluate("[...document.querySelectorAll('tr[data-order=\"DN-E2E-1\"] .lane-chip')].map(e => e.textContent).join(',')")
        record('Stage Lane column shows the floor lanes', lane_cell == 'S51,S52', lane_cell)
        o = next((x for x in orders_rows() if x.get('Order #') == 'DN-E2E-1'), {})
        record('stage lanes written back to the Orders tab', o.get('Stage Lanes') == 'S51, S52' and o.get('Dock') == 'D3'
               and o.get('Pallets On Floor') == 4 and o.get('Pallets Shipped') == 0 and bool(o.get('Floor Updated')), o)
        await pg.fill('#search', 's52'); await pg.wait_for_timeout(150)
        record('search by lane finds the order', await pg.locator('#orders-body tr[data-order]').count() == 1)
        await pg.fill('#search', '')

        # second order + "Save & add another"
        await pg.click('#new-btn'); await pg.wait_for_timeout(150); await pg.fill('#f-orderNumber', 'DN-OLD-7'); await pg.fill('#f-customer', 'Hooli'); await pg.fill('#f-pallets', '3')
        await pg.click('#save-new-btn')
        try:
            await pg.wait_for_function("!document.getElementById('view-form').classList.contains('hidden') && document.getElementById('f-orderNumber').value === '' && !document.getElementById('save-new-btn').disabled", timeout=8000)
        except Exception:
            pass
        record('Save & add another opens a blank form', await pg.is_visible('#view-form') and (await pg.input_value('#f-orderNumber')) == '',
               [await pg.is_visible('#view-form'), await pg.input_value('#f-orderNumber'), await pg.text_content('#form-error'), await pg.text_content('#toast')])
        await pg.click('#form-close-btn'); await pg.wait_for_timeout(200)
        old_text = await pg.text_content('tr[data-order="DN-OLD-7"]') if await pg.locator('tr[data-order="DN-OLD-7"]').count() else ''
        await pg.select_option('#status-filter', 'shipped'); await pg.wait_for_timeout(200)
        record('shipped filter shows the fully shipped order', await pg.locator('tr[data-order="DN-OLD-7"]').count() == 1 and await pg.locator('tr[data-order="DN-E2E-1"]').count() == 0)
        await pg.select_option('#status-filter', 'open'); await pg.wait_for_timeout(200)

        # duplicate warning
        await pg.click('#new-btn'); await pg.wait_for_timeout(150); await pg.fill('#f-orderNumber', 'DN-E2E-1'); await pg.press('#f-orderNumber', 'Tab'); await pg.wait_for_timeout(100)
        record('typing an existing Order # warns', 'already in the portal' in (await pg.text_content('#form-error') or ''))
        await pg.click('#form-close-btn')

        # --- Edit, cancel, restore --------------------------------------------------------------
        await pg.click('tr[data-order="DN-E2E-1"]'); await pg.wait_for_timeout(200)
        record('edit form opens with values and floor box', (await pg.input_value('#f-customer')) == 'Acme Corp' and await pg.is_visible('#form-floor')
               and await pg.get_attribute('#f-orderNumber', 'readonly') is not None)
        await pg.fill('#f-cartons', '250'); await pg.click('#save-btn'); await pg.wait_for_timeout(1400)
        o = next((x for x in orders_rows() if x.get('Order #') == 'DN-E2E-1'), {})
        record('edit saved', o.get('Cartons') == 250 and o.get('Carrier') == 'Saia', o)
        await pg.click('tr[data-order="DN-E2E-1"]'); await pg.click('#cancel-order-btn'); await pg.wait_for_timeout(150)
        record('cancel asks first', await pg.is_visible('#confirm'))
        await pg.click('#confirm-yes'); await pg.wait_for_timeout(1400)
        o = next((x for x in orders_rows() if x.get('Order #') == 'DN-E2E-1'), {})
        record('cancel marks the row Cancelled (not deleted)', o.get('Status') == 'Cancelled', o)
        await pg.select_option('#status-filter', 'cancelled'); await pg.wait_for_timeout(150)
        await pg.click('tr[data-order="DN-E2E-1"]'); await pg.click('#restore-order-btn'); await pg.click('#confirm-yes'); await pg.wait_for_timeout(1400)
        o = next((x for x in orders_rows() if x.get('Order #') == 'DN-E2E-1'), {})
        record('restore sets it back to Released', o.get('Status') == 'Released', o)
        await pg.select_option('#status-filter', 'open')

        # --- CSV import -------------------------------------------------------------------------
        await pg.click('#tabs button[data-view="import"]')
        await pg.screenshot(path=f'{OUT}/intake_import_start.png')
        await pg.set_input_files('#imp-file', csv_path); await pg.wait_for_timeout(500)
        MAPPED = "Object.fromEntries(Object.entries(imp.mapping).map(([k, v]) => [k, v.map(i => imp.headers[i]).join(' + ')]))"
        mapped = await pg.evaluate(MAPPED)
        want = {'orderNumber': 'Delivery No', 'customer': 'Ship To Name', 'cartons': 'Ctns', 'pallets': 'Plts', 'reference': 'ARN', 'carrier': 'Ship Via', 'releasedAt': 'Created Date', 'notes': 'Remarks', 'picker': 'Picked By', 'vrid': 'VRID', 'readyDate': 'Order Ready'}
        record('columns matched from WMS header names', all(mapped.get(k) == v for k, v in want.items()), mapped)
        await pg.fill('input[data-default="refType"]', 'ARN#')
        await pg.screenshot(path=f'{OUT}/intake_import_map.png', full_page=True)
        await pg.set_viewport_size({'width': 1280, 'height': 900})
        await pg.screenshot(path=f'{OUT}/intake_import_map_1280.png', full_page=True)
        await pg.set_viewport_size({'width': 1024, 'height': 800})
        await pg.screenshot(path=f'{OUT}/intake_import_map_1024.png', full_page=True)
        await pg.set_viewport_size({'width': 1440, 'height': 900})
        await pg.click('#imp-preview-btn'); await pg.wait_for_timeout(300)
        counts = await pg.get_attribute('#imp-counts', 'data-summary') or ''
        record('preview: 2 new, 1 update, 3 problems', counts == '2 new · 1 update · 0 skip · 3 with problems', counts)
        await pg.screenshot(path=f'{OUT}/intake_import_preview.png', full_page=True)
        await pg.click('#imp-go-btn'); await pg.wait_for_timeout(2000)
        res = await pg.text_content('#imp-result')
        record('import result shown', '2 added, 1 updated' in res, res)
        rows = {x['Order #']: x for x in orders_rows()}
        g = rows.get('DN-IMP-1', {})
        record('imported order saved with mapped fields', g.get('Customer') == 'Globex, Inc.' and g.get('Cartons') == 120 and g.get('Pallets') == 6
               and g.get('Reference') == 'ARN-1001' and g.get('Reference Type') == 'ARN#' and g.get('Source') == 'WMS import'
               and g.get('Picker') == 'Maria' and g.get('VRID') == 'VR-001' and g.get('Order Ready Date') == '2026-11-25', g)
        record('quoted CSV text kept', rows.get('DN-IMP-2', {}).get('Notes') == 'Call "before" pickup', rows.get('DN-IMP-2'))
        e1 = rows.get('DN-E2E-1', {})
        record('import update changes only columns that have values', e1.get('Pallets') == 7 and e1.get('Customer') == 'Acme Corp' and e1.get('Cartons') == 250, e1)
        record('rows with problems not imported', 'DN-IMP-3' not in rows)

        # mapping remembered for the next file with the same columns
        await pg.reload(); await pg.wait_for_timeout(1200)
        await pg.click('#tabs button[data-view="import"]')
        await pg.set_input_files('#imp-file', csv_path); await pg.wait_for_timeout(400)
        record('default value remembered for next import', (await pg.input_value('input[data-default="refType"]')) == 'ARN#')

        # --- Excel import -----------------------------------------------------------------------
        await pg.click('#imp-change-file')
        await pg.set_input_files('#imp-file', xlsx_path); await pg.wait_for_timeout(1200)
        await pg.select_option('#tpl-select', '')  # no template: plain name matching
        await pg.wait_for_timeout(200)
        record('Excel file read', '2 row(s)' in (await pg.text_content('#imp-row-count') or ''))
        await pg.fill('input[data-default="refType"]', 'PO#')
        await pg.click('#imp-preview-btn'); await pg.wait_for_timeout(300)
        await pg.click('#imp-go-btn'); await pg.wait_for_timeout(1800)
        x = {r['Order #']: r for r in orders_rows()}.get('DN-XL-1', {})
        record('Excel order saved (dates and numbers)', x.get('Customer') == 'Stark Industries' and x.get('Pallets') == 12 and x.get('Reference') == 'PO-77'
               and x.get('Reference Type') == 'PO#' and str(x.get('Released to Warehouse', '')).startswith('2026-11-24'), x)

        # --- Any Excel layout: drag-and-match, combine, save as template ------------------------
        await pg.click('#imp-back-btn'); await pg.wait_for_timeout(150)
        await pg.click('#imp-change-file')
        await pg.set_input_files('#imp-file', amz1); await pg.wait_for_timeout(1500)
        info = await pg.evaluate("({ sheet: imp.sheet, sheets: imp.sheetNames, header: +document.getElementById('imp-header-row').value, rows: imp.rows.length })")
        record('Excel: picks the data sheet and finds the header row under a title', info['sheet'] == 'Orders Export' and info['header'] == 3 and info['rows'] == 2, info)
        mapped = await pg.evaluate(MAPPED)
        record('auto-match finds what it can (Delivery #, Account, VRID, Associate)', mapped.get('orderNumber') == 'Delivery #' and mapped.get('customer') == 'Account'
               and mapped.get('vrid') == 'Load VRID' and mapped.get('picker') == 'Pick Associate' and 'pallets' not in mapped, mapped)
        col = lambda name: pg.locator(f'.col-chip[title="{name}"]')
        await pg.set_viewport_size({'width': 1440, 'height': 2200})  # whole matching screen visible, so the mouse drag doesn't scroll
        async def dnd(src, dst):
            # Exact HTML5 drag events (dragstart → dragover → drop), like a browser sends them
            dt = await pg.evaluate_handle('new DataTransfer()')
            await src.dispatch_event('dragstart', {'dataTransfer': dt})
            await dst.dispatch_event('dragover', {'dataTransfer': dt})
            await dst.dispatch_event('drop', {'dataTransfer': dt})
            await pg.wait_for_timeout(120)
        await pg.evaluate('window.scrollTo(0, 0)')
        # drag "Plt Qty" → Pallets, City and State → Destination (combined)
        await col('Plt Qty').drag_to(pg.locator('[data-drop="pallets"]')); await pg.wait_for_timeout(150)
        await dnd(col('City'), pg.locator('[data-drop="destination"]'))
        await dnd(col('State'), pg.locator('[data-drop="destination"]'))
        # tap-to-match: "Box Qty" → Cartons
        await col('Box Qty').click(); await pg.locator('[data-drop="cartons"]').click(); await pg.wait_for_timeout(150)
        # a mistaken drop, then removed with ×
        await dnd(col('Remark'), pg.locator('[data-drop="reference"]'))
        await pg.click('[data-unmatch="reference"]'); await pg.wait_for_timeout(150)
        await dnd(col('Remark'), pg.locator('[data-drop="notes"]'))
        await pg.fill('input[data-default="orderType"]', 'FTL'); await pg.fill('input[data-default="carrier"]', 'Amazon Freight')
        mapped = await pg.evaluate(MAPPED)
        record('drag-and-drop and tap matched the columns', mapped.get('pallets') == 'Plt Qty' and mapped.get('cartons') == 'Box Qty'
               and mapped.get('destination') == 'City + State' and mapped.get('notes') == 'Remark' and 'reference' not in mapped, mapped)
        dest_ex = await pg.text_content('[data-field="destination"] .ex')
        record('combined example shows "Reno, NV"', 'Reno, NV' in (dest_ex or ''), dest_ex)
        await pg.set_viewport_size({'width': 1440, 'height': 900})
        await pg.screenshot(path=f'{OUT}/intake_dnd.png', full_page=True)
        await pg.click('#tpl-save'); await pg.wait_for_timeout(150)
        await pg.fill('#prompt-input', 'Amazon VRID report'); await pg.click('#prompt-yes'); await pg.wait_for_timeout(1500)
        tdump = dump().get('Import Templates', [])
        record('template saved to the Import Templates tab', len(tdump) == 2 and tdump[1][0] == 'Amazon VRID report' and tdump[1][3] == 'Amy', tdump[:2])
        await pg.click('#imp-preview-btn'); await pg.wait_for_timeout(300)
        await pg.click('#imp-go-btn'); await pg.wait_for_timeout(1800)
        a1 = {r['Order #']: r for r in orders_rows()}.get('DN-AMZ-1', {})
        record('Amazon rows imported with combined and default values', a1.get('Destination') == 'Reno, NV' and a1.get('Pallets') == 10 and a1.get('Cartons') == 400
               and a1.get('VRID') == '115ABC' and a1.get('Picker') == 'Luis' and a1.get('Order Type') == 'FTL' and a1.get('Carrier') == 'Amazon Freight'
               and a1.get('Source') == 'Import: Amazon VRID report', a1)

        # A new device / later day: same report layout → template applied by itself
        await pg.reload(); await pg.wait_for_timeout(1200)
        await pg.evaluate("localStorage.removeItem('outbound_intake_import_map_v1')")
        await pg.click('#tabs button[data-view="import"]'); await pg.wait_for_timeout(800)
        await pg.set_input_files('#imp-file', amz2); await pg.wait_for_timeout(1800)
        sel = await pg.input_value('#tpl-select')
        mapped = await pg.evaluate(MAPPED)
        record('saved template applied automatically to a matching file', sel == 'Amazon VRID report' and mapped.get('destination') == 'City + State'
               and mapped.get('pallets') == 'Plt Qty' and (await pg.input_value('input[data-default="carrier"]')) == 'Amazon Freight', (sel, mapped))
        await pg.click('#imp-preview-btn'); await pg.wait_for_timeout(300)
        await pg.click('#imp-go-btn'); await pg.wait_for_timeout(1800)
        a3 = {r['Order #']: r for r in orders_rows()}.get('DN-AMZ-3', {})
        record('second file imported with the template', a3.get('Destination') == 'Bloomington, CA' and a3.get('Pallets') == 7, a3)
        # Delete the template
        await pg.click('#imp-back-btn'); await pg.wait_for_timeout(150)
        await pg.click('#tpl-delete'); await pg.click('#confirm-yes'); await pg.wait_for_timeout(1500)
        names = [r[0] for r in dump().get('Import Templates', [])[1:] if r and r[0]]
        record('template deleted', names == [] and (await pg.input_value('#tpl-select')) == '', names)

        # --- WMS API push -----------------------------------------------------------------------
        r = req({'fn': 'upsertOrders', 'warehouse': 'ONT', 'key': 'wms-e2e', 'args': [[{'orderNumber': 'DN-API-9', 'customer': 'Cyberdyne', 'pallets': 9, 'carrier': 'ABF Freight'}], {}]})
        record('WMS key can push orders', r.get('ok') and r.get('inserted') == 1, r)
        api_row = {x['Order #']: x for x in orders_rows()}.get('DN-API-9', {})
        record('API orders marked Source = WMS API', api_row.get('Source') == 'WMS API', api_row)
        r = req({'fn': 'listOrders', 'warehouse': 'ONT', 'key': 'wms-e2e', 'args': [{'since': '2000-01-01T00:00:00Z'}]})
        record('WMS key can list orders', r.get('ok') and len(r.get('orders', [])) >= 6, len(r.get('orders', [])))
        await pg.click('#tabs button[data-view="orders"]'); await pg.click('#refresh-btn'); await pg.wait_for_timeout(1500)
        record('pushed order appears in the list', await pg.locator('tr[data-order="DN-API-9"]').count() == 1)
        await pg.select_option('#status-filter', 'all'); await pg.wait_for_timeout(200)
        await pg.screenshot(path=f'{OUT}/intake_orders.png', full_page=True)

        # search
        await pg.fill('#search', 'globex'); await pg.wait_for_timeout(200)
        record('search filters the list', await pg.locator('#orders-body tr[data-order]').count() == 1)
        await pg.fill('#search', '')

        # export
        async with pg.expect_download() as dl:
            await pg.click('#export-btn')
        path = await (await dl.value).path()
        text = open(path, encoding='utf-8-sig').read()
        record('Export CSV includes orders and floor status', 'DN-IMP-1' in text and 'Floor status' in text)

        # --- API page ---------------------------------------------------------------------------
        await pg.click('#tabs button[data-view="api"]'); await pg.wait_for_timeout(300)
        api_text = await pg.text_content('#view-api')
        record('API page shows key status and request format', 'WMS key is set' in api_text and 'upsertOrders' in api_text and 'WMS_API_KEY' in api_text
               and 'wms-e2e' not in api_text)
        await pg.screenshot(path=f'{OUT}/intake_api.png', full_page=True)

        # --- Summary tiles follow the search; missing-carrier count -----------------------------
        req({'fn': 'upsertOrders', 'warehouse': 'ONT', 'key': 'wms-e2e', 'args': [[{'orderNumber': 'DN-NOCAR-1', 'customer': 'Zeta Supply', 'pallets': 2}], {}]})
        await pg.click('#tabs button[data-view="orders"]'); await pg.click('#refresh-btn'); await pg.wait_for_timeout(1200)
        tiles = lambda: pg.evaluate("Object.fromEntries([...document.querySelectorAll('#tiles .tile')].map(t => [t.dataset.tile, +t.querySelector('.n').textContent]))")
        t_all = await tiles()
        record('Missing carrier tile counts open orders with no carrier', t_all.get('nocarrier') == 1
               and await pg.evaluate("document.querySelector('.tile.nocarrier').classList.contains('has')"), t_all)
        await pg.click('.tile.nocarrier'); await pg.wait_for_timeout(200)
        rows_nc = await pg.evaluate("[...document.querySelectorAll('#orders-body tr[data-order]')].map(r => r.dataset.order)")
        record('clicking it lists just those orders, marked No carrier', rows_nc == ['DN-NOCAR-1'] and await pg.is_visible('#orders-body .no-carrier'), rows_nc)
        await pg.select_option('#status-filter', 'all')
        await pg.fill('#search', 'amazon'); await pg.wait_for_timeout(200)
        t_amz = await tiles()
        note = await pg.text_content('#tiles-note') or ''
        record('tiles update to the search result', t_amz.get('waiting') == 3 and t_amz.get('nocarrier') == 0 and t_amz.get('shipped') == 0
               and t_all.get('waiting', 0) > 3 and 'amazon' in note and '3 of' in note, (t_amz, note))
        await pg.screenshot(path=f'{OUT}/intake_tiles.png', full_page=False)
        await pg.fill('#search', ''); await pg.wait_for_timeout(200)
        record('clearing the search restores the totals', await tiles() == t_all and await pg.is_hidden('#tiles-note'))

        # --- Name is entered on the sign-in page only ---------------------------------------------
        await pg.click('#tabs button[data-view="orders"]')
        await pg.evaluate("userName = ''; localStorage.removeItem(INTAKE_USER_KEY); applyWarehouseLabel()")
        await pg.click('#new-btn'); await pg.wait_for_timeout(200)
        record('no name: + New Order goes back to the sign-in page, no pop-up', await pg.is_visible('#signin') and await pg.is_hidden('#prompt') and await pg.is_hidden('#view-form'))
        await pg.fill('#signin-name', 'Amy'); await pg.click('#signin-btn'); await pg.wait_for_timeout(300)
        record('still signed in: entering just the name is enough', await pg.is_hidden('#signin') and (await pg.text_content('#user-btn')) == 'Amy')
        await pg.click('#tabs button[data-view="import"]'); await pg.wait_for_timeout(200)
        record('import opens once a name is set', await pg.is_visible('#view-import'))
        nn = req({'fn': 'upsertOrders', 'key': 'cs-e2e', 'warehouse': 'ONT', 'args': [[{'orderNumber': 'DN-NONAME', 'customer': 'X'}], {}]})
        record('server refuses orders without a name', nn.get('ok') is False and nn.get('needName') is True, nn)

        # --- Reports ----------------------------------------------------------------------------
        tnow = int(time.time() * 1000)
        evs = [{'id': 'r1', 'time': tnow - 6000, 'action': 'SCAN', 'slp': 'DN-OLD-7-01', 'orderNumber': 'DN-OLD-7', 'toLane': 'S60'},
               {'id': 'r2', 'time': tnow - 5000, 'action': 'SCAN', 'slp': 'DN-OLD-7-02', 'orderNumber': 'DN-OLD-7', 'toLane': 'S60'},
               {'id': 'r3', 'time': tnow - 5000, 'action': 'SCAN', 'slp': 'DN-OLD-7-03', 'orderNumber': 'DN-OLD-7', 'toLane': 'S61'},
               {'id': 'r4', 'time': tnow - 4000, 'action': 'DOCK', 'slp': 'DN-OLD-7-01', 'orderNumber': 'DN-OLD-7', 'toLane': 'DOCK-05'},
               {'id': 'r5', 'time': tnow - 3000, 'action': 'SHIP', 'slp': 'DN-OLD-7-01', 'orderNumber': 'DN-OLD-7', 'dockNumber': 'DOCK-05'},
               {'id': 'r6', 'time': tnow - 3000, 'action': 'SHIP', 'slp': 'DN-OLD-7-02', 'orderNumber': 'DN-OLD-7', 'dockNumber': 'DOCK-05'},
               {'id': 'r7', 'time': tnow - 2000, 'action': 'SHIP', 'slp': 'DN-OLD-7-03', 'orderNumber': 'DN-OLD-7', 'dockNumber': 'DOCK-05'},
               {'id': 'r8', 'time': tnow - 2000, 'action': 'SCAN', 'slp': 'DN-E2E-1-09', 'orderNumber': 'DN-E2E-1', 'toLane': 'S52'},
               {'id': 'r9', 'time': tnow - 1000, 'action': 'SCAN', 'slp': 'DN-GHOST-5-01', 'orderNumber': 'DN-GHOST-5', 'toLane': 'W06.74'}]
        record('seed scan log', req({'fn': 'logScanEvents', 'key': 'ont-e2e', 'warehouse': 'ONT', 'args': [evs]}).get('ok'))
        await pg.click('#tabs button[data-view="reports"]'); await pg.wait_for_timeout(1800)
        out = await pg.text_content('#report-out') or ''
        record('EOD report builds for today', 'End of Day' in out and 'Pallets shipped' in out, out[:200])
        kp = await pg.evaluate("[...document.querySelectorAll('#report-out .kpi')].map(k => k.querySelector('.t').textContent + '=' + k.querySelector('.n').textContent)")
        record('EOD totals: 5 staged, 3 shipped, 1 completed', 'Pallets staged=5' in kp and 'Pallets shipped=3' in kp and 'Orders completed=1' in kp, kp)
        shipped_tbl = await pg.evaluate("[...document.querySelectorAll('#report-out .rep-sec')].find(s => s.textContent.includes('Shipped today'))?.textContent || ''")
        record('EOD lists the shipped order with dock and lead time', 'DN-OLD-7' in shipped_tbl and 'D5' in shipped_tbl, shipped_tbl[:200])
        exc = await pg.evaluate("[...document.querySelectorAll('#report-out .rep-sec')].find(s => s.textContent.includes('Exceptions'))?.textContent || ''")
        record('EOD exceptions include a floor order missing from intake', 'DN-GHOST-5' in exc and 'not in Order Intake' in exc, exc[:200])
        open_sec = await pg.evaluate("[...document.querySelectorAll('#report-out .rep-sec')].find(s => s.textContent.includes('Open at end of day'))?.textContent || ''")
        record('EOD open orders include DN-E2E-1 with its lanes', 'DN-E2E-1' in open_sec and 'S51' in open_sec, open_sec[:200])
        by_user = await pg.evaluate("[...document.querySelectorAll('#rep-by-user tbody tr')].map(r => [...r.cells].map(c => c.textContent.trim()))")
        amy = next((r for r in by_user if r[0] == 'Amy'), None)
        record('EOD By user counts orders each person created', amy is not None and int(amy[1]) >= 3, by_user)
        await pg.screenshot(path=f'{OUT}/intake_eod.png', full_page=True)
        await pg.click('.seg button[data-kind="life"]'); await pg.wait_for_timeout(1800)
        rows_life = await pg.evaluate("[...document.querySelectorAll('#report-out .rep-sec:last-of-type tbody tr')].map(r => r.textContent)")
        old7 = next((r for r in rows_life if 'DN-OLD-7' in r), '')
        record('Lifecycle shows every order with milestones and status', len(rows_life) >= 8 and 'Shipped' in old7 and 'D5' in old7, (len(rows_life), old7[:200]))
        life_user = await pg.evaluate("[...document.querySelectorAll('#rep-life-user tbody tr')].map(r => r.cells[0].textContent.trim())")
        record('Lifecycle By user and Created by column', 'Amy' in life_user and 'Amy' in old7, (life_user, old7[:120]))
        await pg.screenshot(path=f'{OUT}/intake_lifecycle.png', full_page=True)
        async with pg.expect_download() as dl:
            await pg.click('#rep-csv')
        csv_text = open(await (await dl.value).path(), encoding='utf-8-sig').read()
        record('Lifecycle CSV export', csv_text.startswith('Order #,Customer,Created by,Last edited by') and 'DN-OLD-7' in csv_text and 'Release to shipped (h)' in csv_text, csv_text[:120])

        # --- Staging app and board untouched --------------------------------------------------
        st = req({'fn': 'loadBoardState', 'key': 'ont-e2e', 'warehouse': 'ONT'})
        record('staging board unchanged by intake', json.loads(st['stateJson']) == board)

        # --- Every screen size, phone to ultra-wide ---------------------------------------------
        sizes = [(360, 780), (768, 1024), (1024, 768), (1440, 900), (1920, 1080), (2560, 1440), (3440, 1440)]
        views = [('orders', "showView('orders')"), ('form', "openForm(null)"), ('import', "showView('import')"),
                 ('eod', "showView('reports'); setReportKind('eod')"), ('life', "showView('reports'); setReportKind('life')")]
        bad = []
        for w, h in sizes:
            await pg.set_viewport_size({'width': w, 'height': h})
            for name, js in views:
                await pg.evaluate(js); await pg.wait_for_timeout(900 if name in ('eod', 'life') else 150)
                over = await pg.evaluate("document.documentElement.scrollWidth - innerWidth")
                if over > 0: bad.append((w, name, over))
                if w in (360, 1024, 2560, 3440):
                    await pg.screenshot(path=f'{OUT}/size_{w}_{name}.png', full_page=False)
        record('no sideways scrolling on any view, 360px to 3440px', not bad, bad)
        await pg.set_viewport_size({'width': 1440, 'height': 900})
        await pg.evaluate("showView('orders')")

        await pg.click('#signout-btn'); await pg.wait_for_timeout(150); await pg.click('#confirm-yes'); await pg.wait_for_timeout(300)
        record('sign out clears the name for the next person', await pg.is_visible('#signin') and await pg.input_value('#signin-name') == '')
        record('no page errors', not errs, errs)

        # --- Phone ------------------------------------------------------------------------------
        ph = await b.new_context(viewport={'width': 390, 'height': 844})
        await ph.route('https://script.google.com/**', to_gas)
        pp = await ph.new_page()
        await pp.goto(f'http://127.0.0.1:{SITE_PORT}/intake.html'); await pp.wait_for_timeout(300)
        await pp.fill('#signin-code', 'cs-e2e'); await pp.fill('#signin-name', 'Kim'); await pp.click('#signin-btn'); await pp.wait_for_timeout(1500)
        overflow = await pp.evaluate("document.documentElement.scrollWidth - innerWidth")
        record('phone: page does not scroll sideways', overflow <= 0, overflow)
        await pp.screenshot(path=f'{OUT}/intake_phone.png', full_page=False)
        await pp.click('#new-btn'); await pp.wait_for_timeout(200)
        await pp.screenshot(path=f'{OUT}/intake_phone_form.png', full_page=False)
        await pp.click('#tabs button[data-view="import"]'); await pp.wait_for_timeout(200)
        await pp.set_input_files('#imp-file', csv_path); await pp.wait_for_timeout(600)
        await pp.screenshot(path=f'{OUT}/intake_phone_import.png', full_page=True)
        ov = await pp.evaluate("document.documentElement.scrollWidth - innerWidth")
        record('phone: import matching fits the screen', ov <= 0, ov)
        await b.close()

try:
    asyncio.run(main())
finally:
    gas.terminate(); site.shutdown()
failed = [n for n, ok in results if not ok]
print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
