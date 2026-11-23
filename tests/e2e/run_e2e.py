"""
End-to-end click-through of the staging board in headless Chrome.

Two devices (separate browser profiles) per warehouse talk to the real Code.gs running
in fake-apps-script.mjs. Every request the page makes to script.google.com is routed there.
Usage: python3 run_e2e.py [rounds]
"""
import asyncio, functools, http.server, json, subprocess, sys, threading, time, urllib.request
from pathlib import Path
from playwright.async_api import async_playwright

REPO = Path(__file__).resolve().parents[2]
E2E = Path(__file__).resolve().parent
OUT = E2E / 'out'; OUT.mkdir(exist_ok=True)
SITE_PORT, GAS_PORT = 8765, 8790
CODES = {'ONT': 'ont-e2e', 'CHINO': 'chino-e2e'}
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 2

results = []  # (warehouse, round, step, ok, detail)


def record(wh, rnd, step, ok, detail=''):
    results.append({'warehouse': wh, 'round': rnd, 'step': step, 'ok': bool(ok), 'detail': str(detail)[:300]})
    print(f"{'PASS' if ok else 'FAIL'}  [{wh} r{rnd}] {step}{'  — ' + str(detail)[:160] if detail and not ok else ''}", flush=True)


def gas_dump():
    with urllib.request.urlopen(f'http://127.0.0.1:{GAS_PORT}/dump') as r:
        return json.loads(r.read())


async def route_externals(context):
    tw_css = (E2E / 'tw.css').read_text()
    tw_js = "(function(){var s=document.createElement('style');s.textContent=" + json.dumps(tw_css) + ";document.head.appendChild(s);})();"
    await context.route('https://cdn.tailwindcss.com/**', lambda r: r.fulfill(body=tw_js, content_type='application/javascript'))
    await context.route('https://cdn.tailwindcss.com', lambda r: r.fulfill(body=tw_js, content_type='application/javascript'))
    lucide = (E2E / 'node_modules/lucide/dist/umd/lucide.min.js').read_text()
    qr = (E2E / 'node_modules/html5-qrcode/html5-qrcode.min.js').read_text()
    await context.route('https://unpkg.com/lucide**', lambda r: r.fulfill(body=lucide, content_type='application/javascript'))
    await context.route('https://unpkg.com/html5-qrcode**', lambda r: r.fulfill(body=qr, content_type='application/javascript'))
    await context.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(body='', content_type='text/css'))
    await context.route('https://fonts.gstatic.com/**', lambda r: r.fulfill(body='', status=204))

    async def to_gas(route):
        req = route.request
        data = req.post_data or ''
        resp = await asyncio.to_thread(lambda: urllib.request.urlopen(
            urllib.request.Request(f'http://127.0.0.1:{GAS_PORT}/exec', data=data.encode(), method='POST')).read())
        await route.fulfill(body=resp, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'})
    await context.route('https://script.google.com/**', to_gas)


async def new_device(browser, wh, name):
    ctx = await browser.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True)
    await route_externals(ctx)
    page = await ctx.new_page()
    page.errors = []
    page.on('pageerror', lambda e: page.errors.append(str(e)))
    page.on('dialog', lambda d: asyncio.ensure_future(d.dismiss()))
    page.device_name = name
    await page.goto(f'http://127.0.0.1:{SITE_PORT}/index.html?wh={wh}', wait_until='domcontentloaded')
    await page.wait_for_timeout(1200)
    return ctx, page


async def state(page, expr):
    return await page.evaluate(expr)


async def slps(page):
    return await page.evaluate("appState.pallets.map(p => p.slp).sort()")


async def badge(page):
    return (await page.text_content('#cloud-sync-label') or '').strip()


async def click_fn(page, fn, nth=0):
    loc = page.locator(f'[onclick^="{fn}("]')
    await loc.nth(nth).click()
    await page.wait_for_timeout(250)


async def wait_for(page, js, timeout=15000):
    end = time.time() + timeout / 1000
    while time.time() < end:
        try:
            if await page.evaluate(js):
                return True
        except Exception:
            pass
        await page.wait_for_timeout(300)
    return False


async def enter_code(page, code):
    await page.wait_for_selector('#access-code-input', timeout=8000)
    await page.fill('#access-code-input', code)
    await page.click('#access-code-box button[type=submit]')
    await page.wait_for_timeout(1500)


async def close_open_modals(page):
    await page.evaluate("""() => document.querySelectorAll('[id$="-modal"]').forEach(m => {
        if (!m.classList.contains('hidden')) { const c = m.querySelector('[onclick^="close"]'); if (c) c.click(); }
    })""")
    await page.wait_for_timeout(200)


async def run_round(browser, wh, rnd, devices):
    code = CODES[wh]
    tag = f'{wh[:2]}{rnd}'
    A, B = devices
    if rnd == 1:
        # --- Access code: wrong code rejected, right code accepted ---------------------------------
        box = await A.is_visible('#access-code-box')
        record(wh, rnd, 'Access-code box shows on first visit', box)
        await enter_code(A, 'wrong-code')
        await A.wait_for_timeout(1200)
        record(wh, rnd, 'Wrong code rejected (box shown again, badge "Access Code Needed")',
               await A.is_visible('#access-code-box') and 'Access Code' in await badge(A), await badge(A))
        await enter_code(A, code)
        ok = await wait_for(A, "document.getElementById('cloud-sync-label').textContent.includes('•')")
        record(wh, rnd, 'Correct code → "Cloud Synced • time"', ok, await badge(A))
        await enter_code(B, code)
        ok = await wait_for(B, "document.getElementById('cloud-sync-label').textContent.includes('Synced')")
        record(wh, rnd, 'Second device signs in', ok, await badge(B))
        other = 'CHINO' if wh == 'ONT' else 'ONT'
        record(wh, rnd, f'Header switcher shows {wh}', await A.input_value('#warehouse-select') == wh)

    # --- Quick scan (single + 2x stack) ---------------------------------------------------------------
    order = f'SO-{tag}-Q'
    await A.fill('#quick-order-input', order)
    await A.fill('#quick-slp-input', f'SLP-{tag}-001')
    await A.press('#quick-slp-input', 'Enter')
    await A.wait_for_timeout(500)
    await A.check('#quick-doublestack-chk')
    await A.fill('#quick-slp-input', f'SLP-{tag}-002')
    await A.press('#quick-slp-input', 'Enter')
    await A.wait_for_timeout(500)
    await A.uncheck('#quick-doublestack-chk')
    s = await slps(A)
    ds = await state(A, f"appState.pallets.find(p => p.slp === 'SLP-{tag}-002')?.doubleStacked")
    record(wh, rnd, 'Quick scan adds SLPs (Enter key)', f'SLP-{tag}-001' in s and f'SLP-{tag}-002' in s, s)
    record(wh, rnd, '2x Stack checkbox marks pallet double-stacked', ds is True)

    # --- Multi-SLP Scan modal (bulk + single manual) ---------------------------------------------------
    await A.click('button:has-text("Multi-SLP Scan")')
    await A.wait_for_timeout(300)
    border = f'SO-{tag}-M'
    await A.fill('#scanner-order-input', border)
    opts = await A.eval_on_selector_all('#scanner-location-select option', 'os => os.map(o => o.value)')
    await A.select_option('#scanner-location-select', opts[min(3, len(opts) - 1)])
    await A.fill('#pallet-carrier-input', 'Estes Express')
    await A.fill('#pallet-dest-input', 'Phoenix DC')
    await A.fill('#bulk-slp-textarea', f'SLP-{tag}-101, SLP-{tag}-102\nSLP-{tag}-103')
    await A.locator('form[onsubmit^="handleBulkMultiSlpSubmit"] button[type=submit]').click()
    await A.wait_for_timeout(500)
    await A.fill('#manual-slp-input', f'SLP-{tag}-104')
    await A.press('#manual-slp-input', 'Enter')
    await A.wait_for_timeout(400)
    await close_open_modals(A)
    s = await slps(A)
    bulk_ok = all(f'SLP-{tag}-{n}' in s for n in (101, 102, 103, 104))
    carrier = await state(A, f"appState.pallets.find(p => p.slp === 'SLP-{tag}-101')?.carrier")
    record(wh, rnd, 'Multi-SLP Scan: bulk list + single manual scan', bulk_ok, s)
    record(wh, rnd, 'Multi-SLP Scan: carrier/destination saved', carrier == 'Estes Express', carrier)

    # --- Other device receives everything ---------------------------------------------------------------
    ok = await wait_for(B, f"['SLP-{tag}-001','SLP-{tag}-104'].every(x => appState.pallets.some(p => p.slp === x))", 20000)
    record(wh, rnd, 'Device B sees A\'s scans (sync within ~10s)', ok, await slps(B))

    # --- Pallet detail on B: edit notes/carrier, move lane --------------------------------------------
    pid = await state(B, f"appState.pallets.find(p => p.slp === 'SLP-{tag}-001')?.id")
    await B.evaluate(f"openPalletDetailModal({json.dumps(pid)})")
    await B.wait_for_timeout(300)
    await B.fill('#detail-notes-input', f'Checked by device B r{rnd}')
    await B.fill('#detail-carrier-input', 'FedEx Freight')
    await B.locator('form[onsubmit^="handleDetailPalletUpdateSubmit"] button[type=submit]').click()
    await B.wait_for_timeout(400)
    note = await state(B, f"appState.pallets.find(p => p.id === {json.dumps(pid)})?.notes")
    record(wh, rnd, 'Pallet detail: save notes + carrier', note == f'Checked by device B r{rnd}', note)
    await B.evaluate(f"openPalletDetailModal({json.dumps(pid)})")
    await B.wait_for_timeout(300)
    move_opts = await B.eval_on_selector_all('#detail-move-select option', 'os => os.map(o => o.value).filter(Boolean)')
    before_col = await state(B, f"appState.pallets.find(p => p.id === {json.dumps(pid)})?.columnId")
    target = next((o for o in move_opts if o != before_col), None)
    if target:
        await B.select_option('#detail-move-select', target)
        await B.wait_for_timeout(500)
    await close_open_modals(B)
    after_col = await state(B, f"appState.pallets.find(p => p.id === {json.dumps(pid)})?.columnId")
    record(wh, rnd, 'Pallet detail: move to another lane', target and after_col == target, f'{before_col} → {after_col}')
    ok = await wait_for(A, f"appState.pallets.find(p => p.id === {json.dumps(pid)})?.columnId === {json.dumps(after_col)} && appState.pallets.find(p => p.id === {json.dumps(pid)})?.notes?.includes('device B')", 20000)
    record(wh, rnd, 'Device A sees B\'s edit + move', ok)

    # --- Orders overview → edit order: dock, add SLP ---------------------------------------------------
    await A.click('button:has-text("Orders")')
    await A.wait_for_timeout(300)
    await A.evaluate(f"openEditOrderModal({json.dumps(border)})")
    await A.wait_for_timeout(300)
    await A.fill('#edit-order-dock-input', 'DOCK-07')
    await A.fill('#edit-order-new-slp-input', f'SLP-{tag}-105')
    await click_fn(A, 'handleAddSlpInsideEditOrder')
    await A.locator('form[onsubmit^="handleSaveEditedOrder"] button[type=submit]').click()
    await A.wait_for_timeout(500)
    await close_open_modals(A)
    docks = await state(A, f"[...new Set(appState.pallets.filter(p => p.orderNumber === {json.dumps(border)}).map(p => p.dockNumber))]")
    record(wh, rnd, 'Edit order: set dock for whole order', docks == ['DOCK-07'], docks)
    record(wh, rnd, 'Edit order: add SLP inside order', f'SLP-{tag}-105' in await slps(A))

    # --- Load dock modal for the quick-scan order -----------------------------------------------------
    await A.evaluate(f"openLoadDockModal({json.dumps(order)})")
    await A.wait_for_timeout(300)
    await A.fill('#load-dock-number-input', 'DOCK-02')
    await A.locator('form[onsubmit^="handleSaveOrderLoadingDock"] button[type=submit]').click()
    await A.wait_for_timeout(400)
    docks = await state(A, f"[...new Set(appState.pallets.filter(p => p.orderNumber === {json.dumps(order)}).map(p => p.dockNumber))]")
    record(wh, rnd, 'Load Dock: assign dock to order', docks == ['DOCK-02'], docks)

    # --- Find Space -------------------------------------------------------------------------------------
    await A.click('button:has-text("Find Space")')
    await A.wait_for_timeout(300)
    await A.fill('#finder-min-slots-input', '3')
    await A.dispatch_event('#finder-min-slots-input', 'input')
    await A.wait_for_timeout(300)
    found = await A.locator('[onclick^="selectFoundLocationAndClose("]').count()
    record(wh, rnd, 'Find Space lists lanes with ≥3 free spots', found > 0, found)
    if found:
        await A.locator('[onclick^="selectFoundLocationAndClose("]').first.click()
        await A.wait_for_timeout(300)
    await close_open_modals(A)

    # --- Carriers + Docks managers ----------------------------------------------------------------------
    await A.click('button:has-text("Carriers")')
    await A.fill('#new-carrier-name-input', f'TEST CARRIER {tag}')
    await A.locator('form[onsubmit^="handleAddCarrierSubmit"] button[type=submit]').click()
    await A.wait_for_timeout(300)
    await close_open_modals(A)
    record(wh, rnd, 'Carriers: add carrier', await state(A, f"appState.carriers.includes('TEST CARRIER {tag}')"))
    await A.click('button:has-text("Docks")')
    await A.fill('#new-dock-name-input', f'DOCK-9{rnd}')
    await A.locator('form[onsubmit^="handleAddDockSubmit"] button[type=submit]').click()
    await A.wait_for_timeout(300)
    await close_open_modals(A)
    record(wh, rnd, 'Docks: add dock', await state(A, f"appState.docks.includes('DOCK-9{rnd}')"))

    # --- Batch: add lanes, then batch capacity ---------------------------------------------------------
    if rnd == 1:
        await A.click('button:has-text("Batch")')
        await A.wait_for_timeout(300)
        prefix = 'T' if wh == 'ONT' else 'C'
        await A.fill('#batch-prefix-input', prefix)
        await A.fill('#batch-start-num-input', '1')
        await A.fill('#batch-end-num-input', '2')
        await A.dispatch_event('#batch-end-num-input', 'input')
        await A.fill('#batch-add-capacity-input', '4')
        await A.locator('form[onsubmit^="handleBatchAddLocationsSubmit"] button[type=submit]').click()
        await A.wait_for_timeout(500)
        names = await state(A, "appState.columns.map(c => c.name)")
        added = [n for n in names if n.startswith(prefix) and n[len(prefix):].lstrip('0') in ('1', '2')]
        record(wh, rnd, 'Batch: add 2 lanes (capacity 4)', len(added) == 2, added)
        await close_open_modals(A)

        # Location modal: rename + capacity
        col = await state(A, f"appState.columns.find(c => c.name.startsWith('{prefix}'))?.id")
        await A.evaluate(f"openLocationModal({json.dumps(col)})")
        await A.wait_for_timeout(300)
        await A.fill('#location-name-input', f'{prefix}-RENAMED')
        await A.fill('#location-capacity-input', '6')
        await A.locator('form[onsubmit^="handleLocationFormSubmit"] button[type=submit]').click()
        await A.wait_for_timeout(400)
        c = await state(A, f"appState.columns.find(c => c.id === {json.dumps(col)})")
        record(wh, rnd, 'Edit lane: rename + capacity', c and c['name'] == f'{prefix}-RENAMED' and int(c['capacity']) == 6, c)
        await close_open_modals(A)

    # --- Dwell alert settings ---------------------------------------------------------------------------
    await A.evaluate("openDwellAlertModal()")
    await A.wait_for_timeout(300)
    await A.fill('#dwell-warning-days-input', '2')
    await A.fill('#dwell-overdue-days-input', '3')
    await A.fill('#dwell-overweek-days-input', '7')
    await A.locator('form[onsubmit^="handleSaveDwellSettings"] button[type=submit]').click()
    await A.wait_for_timeout(300)
    await close_open_modals(A)
    dw = await state(A, "appState.dwellSettings")
    record(wh, rnd, 'Alerts: save dwell thresholds', dw and float(dw.get('warningDays', 0)) == 2 and float(dw.get('overdueDays', 0)) == 3, dw)

    # --- Board views: search, carrier filter, grouped, layout, 2x filter --------------------------------
    await A.fill('#search-filter-input', f'SLP-{tag}-10')
    await A.dispatch_event('#search-filter-input', 'input')
    await A.wait_for_timeout(300)
    vis = await A.evaluate(f"document.querySelectorAll('#staging-board [onclick^=\"openPalletDetailModal(\"]').length")
    record(wh, rnd, 'Search filter narrows the board', vis >= 1, vis)
    await click_fn(A, 'clearSearch')
    await A.click('#card-mode-grouped-btn'); await A.wait_for_timeout(200)
    grouped = await state(A, "appState.cardGroupMode")
    await A.click('#card-mode-pallets-btn'); await A.wait_for_timeout(200)
    record(wh, rnd, 'Grouped / SLPs view toggle', grouped == 'grouped', grouped)
    lm_before = await state(A, "appState.layoutMode")
    await click_fn(A, 'toggleLayoutMode'); lm_after = await state(A, "appState.layoutMode")
    await click_fn(A, 'toggleLayoutMode')
    record(wh, rnd, 'Grid / row layout toggle', lm_before != lm_after, f'{lm_before}→{lm_after}')
    await A.click('#kpi-doublestack-badge'); await A.wait_for_timeout(200)
    await A.click('#kpi-doublestack-badge'); await A.wait_for_timeout(200)
    record(wh, rnd, '2x Stack filter toggles without errors', not A.errors, A.errors[:1])

    # --- Consolidate plan -------------------------------------------------------------------------------
    await A.click('button:has-text("Consolidate")')
    await A.wait_for_timeout(400)
    plan_ok = await A.is_visible('#reorganize-modal') or await A.evaluate("!document.getElementById('reorganize-modal').classList.contains('hidden')")
    record(wh, rnd, 'Consolidate: plan opens', plan_ok)
    await close_open_modals(A)

    # --- Ship single pallet, ship whole order, remove pallet ------------------------------------------
    ship_id = await state(A, f"appState.pallets.find(p => p.slp === 'SLP-{tag}-104')?.id")
    await A.evaluate(f"openPalletDetailModal({json.dumps(ship_id)})")
    await A.wait_for_timeout(300)
    await click_fn(A, 'handleShipActivePallet')
    await A.wait_for_timeout(300)
    if await A.is_visible('#confirm-modal-ok-btn'):
        await A.click('#confirm-modal-ok-btn'); await A.wait_for_timeout(300)
    await close_open_modals(A)
    shipped = await state(A, f"appState.shippedPallets.some(s => s.slp === 'SLP-{tag}-104')")
    record(wh, rnd, 'Ship single pallet', shipped and f'SLP-{tag}-104' not in await slps(A))

    await A.evaluate(f"confirmShipWholeOrder({json.dumps(order)})")
    await A.wait_for_timeout(300)
    if await A.is_visible('#confirm-modal-ok-btn'):
        await A.click('#confirm-modal-ok-btn'); await A.wait_for_timeout(400)
    left = await state(A, f"appState.pallets.filter(p => p.orderNumber === {json.dumps(order)}).length")
    record(wh, rnd, 'Ship whole order (confirm dialog)', left == 0, left)

    rm_id = await state(A, f"appState.pallets.find(p => p.slp === 'SLP-{tag}-103')?.id")
    await A.evaluate(f"openPalletDetailModal({json.dumps(rm_id)})")
    await A.wait_for_timeout(300)
    await click_fn(A, 'handleRemoveActivePallet')
    await A.wait_for_timeout(300)
    if await A.is_visible('#confirm-modal-ok-btn'):
        await A.click('#confirm-modal-ok-btn'); await A.wait_for_timeout(300)
    await close_open_modals(A)
    record(wh, rnd, 'Remove pallet (confirm dialog)', f'SLP-{tag}-103' not in await slps(A))

    # --- EOD report + CSV export, Backup export ---------------------------------------------------------
    await A.click('button:has-text("EOD Report")')
    await A.wait_for_timeout(400)
    async with A.expect_download() as dl:
        await click_fn(A, 'exportEodReportCsv')
    d = await dl.value
    path = OUT / f'{wh}_r{rnd}_{d.suggested_filename}'
    await d.save_as(path)
    csv = path.read_text(errors='ignore')
    record(wh, rnd, 'EOD Report: CSV export includes shipped SLPs', f'SLP-{tag}-104' in csv, d.suggested_filename)
    await close_open_modals(A)
    await A.click('button:has-text("Backup")')
    await A.wait_for_timeout(300)
    async with A.expect_download() as dl:
        await click_fn(A, 'exportStagingDataBackup')
    d = await dl.value
    bpath = OUT / f'{wh}_r{rnd}_{d.suggested_filename}'
    await d.save_as(bpath)
    backup = json.loads(bpath.read_text())
    record(wh, rnd, 'Backup: JSON export has the board', any(p.get('slp') == f'SLP-{tag}-101' for p in backup.get('pallets', backup.get('state', {}).get('pallets', []))) or f'SLP-{tag}-101' in bpath.read_text(), d.suggested_filename)
    await close_open_modals(A)

    # --- Both devices scan at the same moment → both kept --------------------------------------------
    await A.fill('#quick-order-input', f'SO-{tag}-SIM')
    await B.fill('#quick-order-input', f'SO-{tag}-SIM')
    await A.fill('#quick-slp-input', f'SLP-{tag}-A')
    await B.fill('#quick-slp-input', f'SLP-{tag}-B')
    await asyncio.gather(A.press('#quick-slp-input', 'Enter'), B.press('#quick-slp-input', 'Enter'))
    want = f"['SLP-{tag}-A','SLP-{tag}-B'].every(x => appState.pallets.some(p => p.slp === x))"
    okA = await wait_for(A, want, 25000)
    okB = await wait_for(B, want, 25000)
    record(wh, rnd, 'Simultaneous scans on 2 devices → both kept on both', okA and okB)

    # --- Final convergence ------------------------------------------------------------------------------
    await A.wait_for_timeout(9000)
    sa, sb = await slps(A), await slps(B)
    record(wh, rnd, 'Both devices show the identical board', sa == sb, f'A={len(sa)} B={len(sb)}')
    record(wh, rnd, 'No JavaScript errors on either device', not A.errors and not B.errors, (A.errors + B.errors)[:2])


async def main():
    site = http.server.ThreadingHTTPServer(('127.0.0.1', SITE_PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(REPO)))
    site.RequestHandlerClass.log_message = lambda *a: None
    threading.Thread(target=site.serve_forever, daemon=True).start()
    gas = subprocess.Popen(['node', str(E2E / 'fake-apps-script.mjs'), str(REPO / 'Code.gs'), str(GAS_PORT)], stdout=subprocess.PIPE)
    gas.stdout.readline()
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
            for wh in ('ONT', 'CHINO'):
                devA = await new_device(browser, wh, 'A')
                devB = await new_device(browser, wh, 'B')
                for rnd in range(1, ROUNDS + 1):
                    try:
                        await run_round(browser, wh, rnd, (devA[1], devB[1]))
                    except Exception as e:
                        record(wh, rnd, 'Round crashed', False, repr(e))
                        await devA[1].screenshot(path=str(OUT / f'crash_{wh}_r{rnd}.png'))
                await devA[1].screenshot(path=str(OUT / f'board_{wh}_A.png'), full_page=False)
                await devB[1].screenshot(path=str(OUT / f'board_{wh}_B.png'), full_page=False)
                # Warehouse switch from the header on device A
                if wh == 'ONT':
                    await devA[1].select_option('#warehouse-select', 'CHINO')
                    await devA[1].wait_for_timeout(1500)
                    record('ONT', 0, 'Header switcher → CHINO opens the Chino board', 'wh=CHINO' in devA[1].url and await devA[1].evaluate('WAREHOUSE_ID') == 'CHINO', devA[1].url)
                for c, _ in (devA, devB):
                    await c.close()
            await browser.close()
    finally:
        dump = gas_dump()
        for tab, wh in (('Scan Log', 'ONT'), ('Scan Log CHINO', 'CHINO')):
            rows = dump['sheets'].get(tab, [])
            record(wh, 0, 'Scan Log has DOCK rows from the order editor (DOCK-07)', any(r[1] == 'DOCK' and r[9] == 'DOCK-07' for r in rows[1:]))
        (OUT / 'sheet_dump.json').write_text(json.dumps(dump, indent=1))
        (OUT / 'results.json').write_text(json.dumps(results, indent=1))
        gas.terminate()
        site.shutdown()
    passed = sum(r['ok'] for r in results)
    print(f'\n{passed}/{len(results)} checks passed')

asyncio.run(main())
