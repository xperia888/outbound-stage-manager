"""Regression: the page's first request to Google stalls; then a dock and two lanes are added.
They must reach the other device and the sheet once the request times out (25 s)."""
import asyncio, os, sys, json, urllib.request, subprocess, functools, http.server, threading
sys.argv = ['x']
HERE = os.path.dirname(os.path.abspath(__file__)); src = open(os.path.join(HERE, 'run_e2e.py')).read().replace('asyncio.run(main())', '')
E = type(sys)('E'); E.__dict__['__file__'] = os.path.join(HERE, 'run_e2e.py'); exec(compile(src, 'run_e2e.py', 'exec'), E.__dict__)
from playwright.async_api import async_playwright
async def main():
    E.build_css()
    site = http.server.ThreadingHTTPServer(('127.0.0.1', E.SITE_PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(E.REPO)))
    site.RequestHandlerClass.log_message = lambda *a: None
    threading.Thread(target=site.serve_forever, daemon=True).start()
    gas = subprocess.Popen(['node', str(E.E2E/'fake-apps-script.mjs'), str(E.REPO/'Code.gs'), str(E.GAS_PORT)], stdout=subprocess.PIPE); gas.stdout.readline()
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        stall = {'n': 0}
        async def stall_first(route):
            body = route.request.post_data or ''
            if '"loadBoardState"' in body and stall['n'] == 0:
                stall['n'] += 1
                await asyncio.sleep(60)   # never answers in time
                return
            await route.fallback()
        ctxA, A = await E.new_device(b, 'ONT', 'A')
        await ctxA.route('https://script.google.com/**', stall_first)
        await A.reload(); await A.wait_for_timeout(1000)
        _, B = await E.new_device(b, 'ONT', 'B')
        await E.enter_code(A, 'ont-e2e'); await E.enter_code(B, 'ont-e2e')
        await A.wait_for_timeout(1500)
        print('A while its first request stalls: badge =', await E.badge(A), '| load in flight =', await A.evaluate('isCloudLoadInFlight'))
        # A: add a dock, add 2 lanes via Batch, add a carrier
        await A.click('button:has-text("Docks")'); await A.fill('#new-dock-name-input', 'DOCK-13')
        await A.locator('form[onsubmit^="handleAddDockSubmit"] button[type=submit]').click(); await A.wait_for_timeout(300)
        await E.close_open_modals(A)
        await A.click('button:has-text("Batch")'); await A.wait_for_timeout(300)
        await A.fill('#batch-prefix-input', 'S'); await A.fill('#batch-start-num-input', '63'); await A.fill('#batch-end-num-input', '64')
        await A.dispatch_event('#batch-end-num-input', 'input'); await A.fill('#batch-add-capacity-input', '8')
        await A.locator('form[onsubmit^="handleBatchAddLocationsSubmit"] button[type=submit]').click(); await A.wait_for_timeout(300)
        await E.close_open_modals(A)
        print('A right after adding: docks has DOCK-13 =', await A.evaluate("appState.docks.includes('DOCK-13')"), '| lanes =', await A.evaluate("appState.columns.map(c=>c.name).filter(n=>/S6[34]/.test(n))"))
        await A.wait_for_timeout(35000)  # past the 25 s limit + polls
        print('A after 12 s:          docks has DOCK-13 =', await A.evaluate("appState.docks.includes('DOCK-13')"), '| lanes =', await A.evaluate("appState.columns.map(c=>c.name).filter(n=>/S6[34]/.test(n))"), '| badge =', await E.badge(A), '| failed =', await A.evaluate('lastCloudSaveFailed'))
        print('B (other device):      docks has DOCK-13 =', await B.evaluate("appState.docks.includes('DOCK-13')"), '| lanes =', await B.evaluate("appState.columns.map(c=>c.name).filter(n=>/S6[34]/.test(n))"))
        dump = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{E.GAS_PORT}/dump').read())
        rows = dump['sheets']['StateChunks']
        stored = json.loads(''.join(str(r[0])[1:] for r in rows[2:2+int(rows[1][2])]))
        print('Sheet:                 docks has DOCK-13 =', 'DOCK-13' in stored.get('docks', []), '| lanes =', [c['name'] for c in stored['columns'] if c['name'] in ('S63','S64')])
        ok = 'DOCK-13' in stored.get('docks', []) and {'S63', 'S64'} <= {c['name'] for c in stored['columns']} and await B.evaluate("appState.docks.includes('DOCK-13')")
        print('RESULT:', 'PASS' if ok else 'FAIL')
        from collections import Counter
        print('requests:', Counter((r['fn'], 'ok' if r['ok'] else ('conflict' if r['conflict'] else 'err')) for r in dump['requests']))
        await b.close()
    gas.terminate(); site.shutdown()
asyncio.run(main())
