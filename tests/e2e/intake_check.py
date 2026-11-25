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
    f.write('﻿Delivery No,Ship To Name,Ctns,Plts,ARN,Ship Via,Created Date,Remarks,Picked By,VRID\r\n'
            'dn-imp-1,"Globex, Inc.",120,6,ARN-1001,Saia,11/24/2026 9:15 AM,,Maria,vr-001\r\n'
            'DN-IMP-2,Initech,80,4,ARN-1002,Estes Express,11/24/2026 10:40 AM,"Call ""before"" pickup",,\r\n'
            'DN-E2E-1,,,7,,,,,,\r\n'                      # existing order: only pallets changes
            'DN-IMP-3,Umbrella,ten,2,ARN-1003,UPS,11/24/2026 11:00 AM,,,\r\n'  # bad cartons
            'DN-IMP-1,Globex,1,1,,,,,,\r\n'                # duplicate in file
            ',No Number Co,1,1,,,,,,\r\n')
xlsx_path = os.path.join(OUT, 'wms_export.xlsx')
wb = openpyxl.Workbook(); ws = wb.active
ws.append(['Order Number', 'Customer', 'Cartons', 'Pallets', 'PO', 'Carrier', 'Release Date'])
from datetime import datetime
ws.append(['DN-XL-1', 'Stark Industries', 300, 12, 'PO-77', 'Old Dominion', datetime(2026, 11, 24, 13, 30)])
ws.append(['DN-XL-2', 'Wayne Enterprises', 40, 2, 'PO-78', 'XPO Logistics', datetime(2026, 11, 24, 14, 0)])
wb.save(xlsx_path)

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
        await pg.fill('#f-carrier', 'Saia'); await pg.fill('#f-scac', 'saia'); await pg.fill('#f-shipDate', '2026-11-26')
        await pg.fill('#f-destination', 'Phoenix, AZ')
        await pg.fill('#f-picker', 'Jose M.'); await pg.fill('#f-vrid', '115xyz7ab')
        await pg.screenshot(path=f'{OUT}/intake_form.png', full_page=True)
        await pg.click('#save-btn'); await pg.wait_for_timeout(1500)
        rows = orders_rows()
        o = next((x for x in rows if x.get('Order #') == 'DN-E2E-1'), {})
        record('new order saved to the Orders tab', o.get('Customer') == 'Acme Corp' and o.get('Pallets') == 6 and o.get('Reference Type') == 'ARN#'
               and o.get('SCAC') == 'SAIA' and o.get('Entered By') == 'Amy' and o.get('Source') == 'Manual' and o.get('Status') == 'Released'
               and o.get('Picker') == 'Jose M.' and o.get('VRID') == '115XYZ7AB', o)
        record('release time filled in', bool(o.get('Released to Warehouse')))
        row_text = await pg.text_content('tr[data-order="DN-E2E-1"]') or ''
        record('list shows floor progress from the board (At D3, 4/6)', 'At D3' in row_text and '4/6' in row_text, row_text)

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
        mapped = await pg.evaluate("Object.fromEntries([...document.querySelectorAll('select[data-map]')].map(s => [s.dataset.map, s.value === '' ? '' : s.options[s.selectedIndex].text]))")
        want = {'orderNumber': 'Delivery No', 'customer': 'Ship To Name', 'cartons': 'Ctns', 'pallets': 'Plts', 'reference': 'ARN', 'carrier': 'Ship Via', 'releasedAt': 'Created Date', 'notes': 'Remarks', 'picker': 'Picked By', 'vrid': 'VRID'}
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
               and g.get('Picker') == 'Maria' and g.get('VRID') == 'VR-001', g)
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
        record('Excel file read', '2 row(s)' in (await pg.text_content('#imp-row-count') or ''))
        await pg.fill('input[data-default="refType"]', 'PO#')
        await pg.click('#imp-preview-btn'); await pg.wait_for_timeout(300)
        await pg.click('#imp-go-btn'); await pg.wait_for_timeout(1800)
        x = {r['Order #']: r for r in orders_rows()}.get('DN-XL-1', {})
        record('Excel order saved (dates and numbers)', x.get('Customer') == 'Stark Industries' and x.get('Pallets') == 12 and x.get('Reference') == 'PO-77'
               and x.get('Reference Type') == 'PO#' and str(x.get('Released to Warehouse', '')).startswith('2026-11-24'), x)

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

        # --- Staging app and board untouched --------------------------------------------------
        st = req({'fn': 'loadBoardState', 'key': 'ont-e2e', 'warehouse': 'ONT'})
        record('staging board unchanged by intake', json.loads(st['stateJson']) == board)

        record('no page errors', not errs, errs)

        # --- Phone ------------------------------------------------------------------------------
        ph = await b.new_context(viewport={'width': 390, 'height': 844})
        await ph.route('https://script.google.com/**', to_gas)
        pp = await ph.new_page()
        await pp.goto(f'http://127.0.0.1:{SITE_PORT}/intake.html'); await pp.wait_for_timeout(300)
        await pp.fill('#signin-code', 'cs-e2e'); await pp.click('#signin-btn'); await pp.wait_for_timeout(1500)
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
