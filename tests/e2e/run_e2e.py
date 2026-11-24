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


async def new_device(browser, wh, name, plain_link=False):
    ctx = await browser.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True)
    await route_externals(ctx)
    page = await ctx.new_page()
    page.errors = []
    page.on('pageerror', lambda e: page.errors.append(str(e)))
    page.on('dialog', lambda d: asyncio.ensure_future(d.dismiss()))
    page.device_name = name
    suffix = '' if plain_link else f'?wh={wh}'
    await page.goto(f'http://127.0.0.1:{SITE_PORT}/index.html{suffix}', wait_until='domcontentloaded')
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


async def accept_capacity_warning(page):
    """Regular steps: if a lane is full, answer the over-capacity warning with "Put it anyway"."""
    await page.wait_for_timeout(250)
    title = await page.text_content('#confirm-modal-title') or ''
    if await page.is_visible('#confirm-modal-ok-btn') and ('over capacity' in title or 'has room for' in title):
        await page.click('#confirm-modal-ok-btn')
        await page.wait_for_timeout(350)
        return True
    return False


async def enter_code(page, code, expect_wh=None):
    await page.wait_for_selector('#access-code-input', timeout=8000)
    await page.fill('#access-code-input', code)
    await page.click('#access-code-box button[type=submit]')
    if expect_wh and await page.evaluate('WAREHOUSE_ID') != expect_wh:
        # The code belongs to another warehouse: the page switches to it
        await page.wait_for_url(f'**wh={expect_wh}**', timeout=10000)
        await page.wait_for_load_state('domcontentloaded')
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
        await A.fill('#access-code-input', 'wrong-code')
        await A.click('#access-code-box button[type=submit]')
        await A.wait_for_timeout(1500)
        err = (await A.text_content('#access-code-error') or '').strip()
        record(wh, rnd, 'Wrong code rejected inside the box',
               await A.is_visible('#access-code-box') and 'not recognized' in err, err)
        start_wh = await A.evaluate('WAREHOUSE_ID')
        await enter_code(A, code, expect_wh=wh)
        record(wh, rnd, f'Code opens {wh} (page started on {start_wh})', await A.evaluate('WAREHOUSE_ID') == wh, A.url)
        ok = await wait_for(A, "document.getElementById('cloud-sync-label').textContent.includes('•')")
        record(wh, rnd, 'Correct code → "Cloud Synced • time"', ok, await badge(A))
        await enter_code(B, code, expect_wh=wh)
        ok = await wait_for(B, "document.getElementById('cloud-sync-label').textContent.includes('Synced')")
        record(wh, rnd, 'Second device signs in', ok, await badge(B))
        other = 'CHINO' if wh == 'ONT' else 'ONT'
        record(wh, rnd, f'Header switcher shows {wh}', await A.input_value('#warehouse-select') == wh)

    # --- Quick add: scan/type order → Enter jumps to pallet count → Enter adds the shipment ------------
    order = f'SO-{tag}-Q'
    await A.fill('#quick-order-input', order)
    await A.press('#quick-order-input', 'Enter')
    focused = await A.evaluate("document.activeElement && document.activeElement.id")
    record(wh, rnd, 'Enter on the order number jumps to the pallet count', focused == 'quick-pallet-count', focused)
    await A.keyboard.type('1')
    await A.keyboard.press('Enter')
    await accept_capacity_warning(A)
    await A.wait_for_timeout(300)
    await A.fill('#quick-order-input', order)
    await A.check('#quick-doublestack-chk')
    await A.fill('#quick-pallet-count', '2')
    await A.press('#quick-pallet-count', 'Enter')
    await accept_capacity_warning(A)
    await A.wait_for_timeout(300)
    await A.uncheck('#quick-doublestack-chk')
    s = await slps(A)
    ds = await state(A, f"appState.pallets.find(p => p.slp === '{order}-02')?.doubleStacked")
    cleared = await A.input_value('#quick-order-input') == '' and await A.input_value('#quick-pallet-count') == ''
    record(wh, rnd, 'Quick add: order + pallet count → pallets ORDER-01…03', all(f'{order}-0{n}' in s for n in (1, 2, 3)), s)
    record(wh, rnd, '2x Stack checkbox marks pallets double-stacked', ds is True)
    record(wh, rnd, 'Quick add clears the boxes for the next shipment', cleared)

    # --- Scan Order window: order + carrier/destination + number of pallets ---------------------------
    await A.click('button:has-text("Scan Order")')
    await A.wait_for_timeout(200)
    order_box = await A.locator('#scanner-order-input').bounding_box()
    count_box = await A.locator('#scanner-pallet-count').bounding_box()
    lane_box = await A.locator('#scanner-location-select').bounding_box()
    record(wh, rnd, 'Scan Order: pallet count sits right under the order number',
           order_box and count_box and lane_box and order_box['y'] < count_box['y'] < lane_box['y'] and count_box['y'] - order_box['y'] < 90, (order_box, count_box))
    await A.wait_for_timeout(300)
    border = f'SO-{tag}-M'
    await A.fill('#scanner-order-input', border)
    opts = await A.eval_on_selector_all('#scanner-location-select option', 'os => os.map(o => o.value)')
    await A.select_option('#scanner-location-select', opts[min(3, len(opts) - 1)])
    await A.fill('#pallet-carrier-input', 'Estes Express')
    await A.fill('#pallet-dest-input', 'Phoenix DC')
    await A.fill('#scanner-pallet-count', '4')
    await A.locator('form[onsubmit^="handleModalShipmentSubmit"] button[type=submit]').click()
    await accept_capacity_warning(A)
    await A.wait_for_timeout(300)
    await close_open_modals(A)
    s = await slps(A)
    bulk_ok = all(f'{border}-0{n}' in s for n in (1, 2, 3, 4))
    carrier = await state(A, f"appState.pallets.find(p => p.slp === '{border}-01')?.carrier")
    record(wh, rnd, 'Scan Order window: 4 pallets added for the order', bulk_ok, s)
    record(wh, rnd, 'Scan Order window: carrier/destination saved', carrier == 'Estes Express', carrier)

    # --- Other device receives everything ---------------------------------------------------------------
    ok = await wait_for(B, f"['{order}-01','{border}-04'].every(x => appState.pallets.some(p => p.slp === x))", 20000)
    record(wh, rnd, 'Device B sees A\'s scans (sync within ~10s)', ok, await slps(B))

    # --- Pallet detail on B: edit notes/carrier, move lane --------------------------------------------
    pid = await state(B, f"appState.pallets.find(p => p.slp === '{order}-01')?.id")
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
        await accept_capacity_warning(B)
        await B.wait_for_timeout(300)
    await close_open_modals(B)
    after_col = await state(B, f"appState.pallets.find(p => p.id === {json.dumps(pid)})?.columnId")
    record(wh, rnd, 'Pallet detail: move to another lane', target and after_col == target, f'{before_col} → {after_col}')
    ok = await wait_for(A, f"appState.pallets.find(p => p.id === {json.dumps(pid)})?.columnId === {json.dumps(after_col)} && appState.pallets.find(p => p.id === {json.dumps(pid)})?.notes?.includes('device B')", 20000)
    record(wh, rnd, 'Device A sees B\'s edit + move', ok)

    # --- Orders overview → edit order: dock, add a pallet ---------------------------------------------------
    await A.click('button:has-text("Orders")')
    await A.wait_for_timeout(300)
    await A.evaluate(f"openEditOrderModal({json.dumps(border)})")
    await A.wait_for_timeout(300)
    await A.fill('#edit-order-dock-input', 'DOCK-07')
    await A.fill('#edit-order-new-pallet-count', '1')
    await click_fn(A, 'handleAddPalletsInsideEditOrder')
    await accept_capacity_warning(A)
    await A.locator('form[onsubmit^="handleSaveEditedOrder"] button[type=submit]').click()
    await accept_capacity_warning(A)
    await A.wait_for_timeout(300)
    await close_open_modals(A)
    docks = await state(A, f"[...new Set(appState.pallets.filter(p => p.orderNumber === {json.dumps(border)}).map(p => p.dockNumber))]")
    record(wh, rnd, 'Edit order: set dock for whole order', docks == ['DOCK-07'], docks)
    record(wh, rnd, 'Edit order: add a pallet to the order', f'{border}-05' in await slps(A))

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
    prefix = 'T' if wh == 'ONT' else 'C'
    if rnd == 1:
        await A.click('button:has-text("Batch")')
        await A.wait_for_timeout(300)
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

    # --- Over-capacity warning (rnd 1): warn, allow continue, cancel keeps things as they were ---------
    if rnd == 1:
        lane = await state(A, f"appState.columns.find(c => c.name.startsWith('{prefix}') && Number(c.capacity) === 4)?.id")
        lane_name = await state(A, f"appState.columns.find(c => c.id === {json.dumps(lane)}).name")

        async def quick_into_lane(count):
            # Order first (typing it auto-picks a lane), then choose the lane by hand, like on the floor
            await A.fill('#quick-order-input', f'SO-{tag}-CAP')
            await A.select_option('#quick-scan-location', lane)
            await A.fill('#quick-pallet-count', str(count))
            await A.press('#quick-pallet-count', 'Enter')
            await A.wait_for_timeout(350)

        await quick_into_lane(4)  # fill the 4-spot lane
        in_lane = lambda: state(A, f"appState.pallets.filter(p => p.columnId === {json.dumps(lane)}).length")
        dbg = await state(A, f"({{lane: {json.dumps(lane)}, cols: appState.columns.map(c => c.name + ':' + c.capacity).join(' '), inLane: appState.pallets.filter(p => p.columnId === {json.dumps(lane)}).map(p => p.slp), sel: document.getElementById('quick-scan-location').value, confirm: document.getElementById('confirm-modal-message').textContent}})")
        record(wh, rnd, 'Capacity: lane filled to 4/4 without any warning', await in_lane() == 4 and not await A.is_visible('#confirm-modal'), dbg)

        await quick_into_lane(1)
        shown = await A.is_visible('#confirm-modal')
        title = (await A.text_content('#confirm-modal-title') or '').strip()
        msg = (await A.text_content('#confirm-modal-message') or '').strip()
        record(wh, rnd, 'Full lane: 5th pallet offers to spread to the next lane', shown and f'{lane_name} has room for 0 of 1' in title and 'Spread' in msg, title + ' | ' + msg)
        await A.locator('#confirm-modal button:has-text("Cancel")').click()
        await A.wait_for_timeout(300)
        record(wh, rnd, 'Capacity: Cancel → not added', await in_lane() == 4 and not await A.is_visible('#confirm-modal'))

        await quick_into_lane(1)
        await A.click('#confirm-modal-ok-btn')
        await A.wait_for_timeout(400)
        spread = await state(A, f"appState.pallets.filter(p => p.orderNumber === 'SO-{tag}-CAP' && p.columnId !== {json.dumps(lane)}).length")
        record(wh, rnd, 'Full lane: "Spread over lanes" puts it in the next lane', await in_lane() == 4 and spread == 1, spread)

        # Shipment bigger than all free space → over-capacity warning, "Put it anyway" puts all in the lane
        free_total = await state(A, "appState.columns.reduce((t, c) => t + Math.max(0, (Number(c.capacity) || 0) - computeFloorSpotsUsed(appState.pallets.filter(p => p.columnId === c.id))), 0)")
        await A.click('button:has-text("Scan Order")')
        await A.wait_for_timeout(300)
        await A.fill('#scanner-order-input', f'SO-{tag}-CAP')
        await A.select_option('#scanner-location-select', lane)
        await A.uncheck('#scanner-doublestack-chk')
        await A.fill('#scanner-pallet-count', str(free_total + 1))
        await A.locator('form[onsubmit^="handleModalShipmentSubmit"] button[type=submit]').click()
        await A.wait_for_timeout(300)
        msg = (await A.text_content('#confirm-modal-message') or '').strip()
        on_top = await A.is_visible('#confirm-modal-ok-btn')
        record(wh, rnd, 'Capacity: no room anywhere → over-capacity warning on top of the scan window', on_top and f'would use {4 + free_total + 1} of 4' in msg, msg)
        await A.click('#confirm-modal-ok-btn')
        await A.wait_for_timeout(400)
        await close_open_modals(A)
        record(wh, rnd, 'Capacity: "Put it anyway" adds them all to the lane', await in_lane() == 4 + free_total + 1)

        # Move a pallet into the full lane from the detail dialog → Cancel keeps it where it was
        mover = await state(A, f"appState.pallets.find(p => p.columnId !== {json.dumps(lane)})")
        await A.evaluate(f"openPalletDetailModal({json.dumps(mover['id'])})")
        await A.wait_for_timeout(300)
        await A.select_option('#detail-move-select', lane)
        await A.wait_for_timeout(300)
        warned = await A.is_visible('#confirm-modal')
        await A.locator('#confirm-modal button:has-text("Cancel")').click()
        await A.wait_for_timeout(300)
        still = await state(A, f"appState.pallets.find(p => p.id === {json.dumps(mover['id'])}).columnId")
        shown_lane = await A.input_value('#detail-move-select')
        record(wh, rnd, 'Capacity: detail move warns; Cancel leaves pallet and dropdown unchanged',
               warned and still == mover['columnId'] and shown_lane == mover['columnId'], f'{still} / {shown_lane}')
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
    await A.fill('#search-filter-input', f'{border}-0')
    await A.dispatch_event('#search-filter-input', 'input')
    await A.wait_for_timeout(300)
    vis = await A.evaluate(f"document.querySelectorAll('#staging-board [onclick^=\"openPalletDetailModal(\"]').length")
    record(wh, rnd, 'Search filter narrows the board', vis >= 1, vis)
    shown = await A.evaluate("[...document.querySelectorAll('#staging-board [id^=lane-card-]')].map(e => e.id)")
    want = await state(A, f"[...new Set(appState.pallets.filter(p => p.slp.toLowerCase().includes('{border}-0'.toLowerCase())).map(p => 'lane-card-' + p.columnId))]")
    record(wh, rnd, 'Search shows only the lanes with a match', sorted(shown) == sorted(want) and len(shown) < await state(A, 'appState.columns.length'), shown)
    await A.fill('#search-filter-input', 'Estes Express')
    await A.dispatch_event('#search-filter-input', 'input')
    await A.wait_for_timeout(300)
    lanes_ok = await A.evaluate("[...document.querySelectorAll('#staging-board [id^=lane-card-]')].every(e => /Estes Express/i.test(e.textContent))")
    record(wh, rnd, 'Carrier search shows only lanes holding that carrier', lanes_ok)
    await click_fn(A, 'clearSearch')
    names = await A.evaluate("[...document.querySelectorAll('#staging-board [id^=lane-card-]')].map(e => appState.columns.find(c => 'lane-card-' + c.id === e.id).name)")
    import re as _re
    s_part = [n for n in names if _re.fullmatch(r'S\d+', n)]
    rest = names[len(s_part):]
    ok_order = names[:len(s_part)] == s_part and [int(n[1:]) for n in s_part] == sorted(int(n[1:]) for n in s_part) \
        and not any(_re.fullmatch(r'S\d+', n) for n in rest)
    record(wh, rnd, 'Board lists S lanes by number first, then other locations', ok_order, names)

    # Find Space with 2x pallets: 2 per floor spot, and the choice carries to the quick bar
    await A.click('button:has-text("Find Space")'); await A.wait_for_timeout(300)
    await A.uncheck('#finder-doublestack-chk')
    await A.fill('#finder-min-slots-input', '16')
    await A.dispatch_event('#finder-min-slots-input', 'input')
    single = await A.evaluate("document.querySelectorAll('#finder-results-list button').length")
    await A.check('#finder-doublestack-chk'); await A.wait_for_timeout(200)
    double = await A.evaluate("document.querySelectorAll('#finder-results-list button').length")
    stats = (await A.text_content('#finder-summary-stats') or '').strip()
    exp_single = await state(A, "appState.columns.filter(c => palletRoomInLane(c, false) >= 16).length")
    exp_double = await state(A, "appState.columns.filter(c => palletRoomInLane(c, true) >= 16).length")
    record(wh, rnd, 'Find Space: 2x option counts 2 pallets per spot', single == exp_single and double == exp_double and double >= single and '(8 floor spots)' in stats, f'{single}/{exp_single} -> {double}/{exp_double} {stats}')
    await A.locator('#finder-results-list button').first.click(); await A.wait_for_timeout(200)
    carried = await A.evaluate("document.getElementById('quick-doublestack-chk').checked && document.getElementById('quick-pallet-count').value === '16'")
    record(wh, rnd, 'Find Space: "Use Location" carries 2x + pallet count to the quick bar', carried)
    await A.uncheck('#quick-doublestack-chk'); await A.fill('#quick-pallet-count', '')
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
    ship_id = await state(A, f"appState.pallets.find(p => p.slp === '{border}-04')?.id")
    await A.evaluate(f"openPalletDetailModal({json.dumps(ship_id)})")
    await A.wait_for_timeout(300)
    await click_fn(A, 'handleShipActivePallet')
    await A.wait_for_timeout(300)
    if await A.is_visible('#confirm-modal-ok-btn'):
        await A.click('#confirm-modal-ok-btn'); await A.wait_for_timeout(300)
    await close_open_modals(A)
    shipped = await state(A, f"appState.shippedPallets.some(s => s.slp === '{border}-04')")
    record(wh, rnd, 'Ship single pallet', shipped and f'{border}-04' not in await slps(A))

    await A.evaluate(f"confirmShipWholeOrder({json.dumps(order)})")
    await A.wait_for_timeout(300)
    if await A.is_visible('#confirm-modal-ok-btn'):
        await A.click('#confirm-modal-ok-btn'); await A.wait_for_timeout(400)
    left = await state(A, f"appState.pallets.filter(p => p.orderNumber === {json.dumps(order)}).length")
    record(wh, rnd, 'Ship whole order (confirm dialog)', left == 0, left)

    rm_id = await state(A, f"appState.pallets.find(p => p.slp === '{border}-03')?.id")
    await A.evaluate(f"openPalletDetailModal({json.dumps(rm_id)})")
    await A.wait_for_timeout(300)
    await click_fn(A, 'handleRemoveActivePallet')
    await A.wait_for_timeout(300)
    if await A.is_visible('#confirm-modal-ok-btn'):
        await A.click('#confirm-modal-ok-btn'); await A.wait_for_timeout(300)
    await close_open_modals(A)
    record(wh, rnd, 'Remove pallet (confirm dialog)', f'{border}-03' not in await slps(A))

    # Delete order from the Orders window: confirm dialog, gone on both devices, not shipped
    del_order = f'SO-{tag}-DEL'
    await A.fill('#quick-order-input', del_order)
    await A.fill('#quick-pallet-count', '3')
    await A.press('#quick-pallet-count', 'Enter')
    await accept_capacity_warning(A)
    await A.wait_for_timeout(300)
    ok_b = await wait_for(B, f"appState.pallets.filter(p => p.orderNumber === '{del_order}').length === 3", 20000)
    await A.click('button:has-text("Orders")'); await A.wait_for_timeout(300)
    await A.click(f'#orders-summary-list button[onclick*="confirmDeleteWholeOrder"][onclick*="{del_order}"]'); await A.wait_for_timeout(300)
    title = (await A.text_content('#confirm-modal-title') or '').strip()
    still = await state(A, f"appState.pallets.filter(p => p.orderNumber === '{del_order}').length")
    await A.click('#confirm-modal-ok-btn'); await A.wait_for_timeout(400)
    await close_open_modals(A)
    gone_a = await state(A, f"!appState.pallets.some(p => p.orderNumber === '{del_order}') && !appState.shippedPallets.some(s => s.orderNumber === '{del_order}')")
    gone_b = await wait_for(B, f"!appState.pallets.some(p => p.orderNumber === '{del_order}')", 20000)
    record(wh, rnd, 'Delete order: asks first (nothing removed before confirming)', ok_b and title == f'Delete Order {del_order}?' and still == 3, title)
    record(wh, rnd, 'Delete order: removed on both devices, not logged as shipped', gone_a and gone_b)

    # --- EOD report + CSV export, Backup export ---------------------------------------------------------
    await A.click('button:has-text("EOD Report")')
    await A.wait_for_timeout(400)
    async with A.expect_download() as dl:
        await click_fn(A, 'exportEodReportCsv')
    d = await dl.value
    path = OUT / f'{wh}_r{rnd}_{d.suggested_filename}'
    await d.save_as(path)
    csv = path.read_text(errors='ignore')
    record(wh, rnd, 'EOD Report: CSV export includes shipped pallets', f'{border}-04' in csv, d.suggested_filename)
    await close_open_modals(A)
    await A.click('button:has-text("Backup")')
    await A.wait_for_timeout(300)
    async with A.expect_download() as dl:
        await click_fn(A, 'exportStagingDataBackup')
    d = await dl.value
    bpath = OUT / f'{wh}_r{rnd}_{d.suggested_filename}'
    await d.save_as(bpath)
    backup = json.loads(bpath.read_text())
    record(wh, rnd, 'Backup: JSON export has the board', f'{border}-01' in bpath.read_text(), d.suggested_filename)
    await close_open_modals(A)

    # --- Both devices scan at the same moment → both kept --------------------------------------------
    await A.fill('#quick-order-input', f'SO-{tag}-SIM')
    await B.fill('#quick-order-input', f'SO-{tag}-SIM')
    await A.fill('#quick-pallet-count', '2')
    await B.fill('#quick-pallet-count', '3')
    await asyncio.gather(A.press('#quick-pallet-count', 'Enter'), B.press('#quick-pallet-count', 'Enter'))
    await asyncio.gather(accept_capacity_warning(A), accept_capacity_warning(B))
    want = f"appState.pallets.filter(p => p.orderNumber === 'SO-{tag}-SIM').length === 5"
    okA = await wait_for(A, want, 25000)
    okB = await wait_for(B, want, 25000)
    record(wh, rnd, 'Two devices add the same order at once → all 5 pallets kept on both', okA and okB)

    # --- Final convergence ------------------------------------------------------------------------------
    await A.wait_for_timeout(9000)
    sa, sb = await slps(A), await slps(B)
    record(wh, rnd, 'Both devices show the identical board', sa == sb, f'A={len(sa)} B={len(sb)}')
    record(wh, rnd, 'No JavaScript errors on either device', not A.errors and not B.errors, (A.errors + B.errors)[:2])


def build_css():
    """Rebuild tw.css from index.html every run, so new Tailwind classes (e.g. z-[60]) exist in tests too."""
    (E2E / 'in.css').write_text('@tailwind base;@tailwind components;@tailwind utilities;')
    subprocess.run(['npx', 'tailwindcss', '-i', 'in.css', '-o', 'tw.css', '--minify'], cwd=E2E, check=True, capture_output=True)


async def main():
    build_css()
    site = http.server.ThreadingHTTPServer(('127.0.0.1', SITE_PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(REPO)))
    site.RequestHandlerClass.log_message = lambda *a: None
    threading.Thread(target=site.serve_forever, daemon=True).start()
    gas = subprocess.Popen(['node', str(E2E / 'fake-apps-script.mjs'), str(REPO / 'Code.gs'), str(GAS_PORT)], stdout=subprocess.PIPE)
    gas.stdout.readline()
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
            for wh in ('ONT', 'CHINO'):
                # CHINO devices open the plain link (ONT by default) and let the code pick Chino
                devA = await new_device(browser, wh, 'A', plain_link=(wh == 'CHINO'))
                devB = await new_device(browser, wh, 'B', plain_link=(wh == 'CHINO'))
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
