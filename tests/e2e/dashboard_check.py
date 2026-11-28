"""Seeds a realistic board into the in-memory sheet, opens dashboard.html at TV sizes,
signs in, and checks for page errors and cut-off labels. Screenshots go to out/."""
import asyncio, functools, http.server, threading, json, subprocess, time, urllib.request, random
from playwright.async_api import async_playwright
import os
E2E=os.path.dirname(os.path.abspath(__file__)); REPO=os.path.abspath(os.path.join(E2E, '..', '..'))
now=int(time.time()*1000); H=3600_000; D=24*H
random.seed(7)
# Same shape as the real ONT board: zones W05/W06/N09 first, then S lanes in the order they were added
zone_cols=[{'id':f'col-w05-{n}','name':f'W05.{n}','capacity':4} for n in range(89,113)]+\
          [{'id':f'col-w06-{n}','name':f'W06.{n}','capacity':4} for n in range(61,81)]+\
          [{'id':f'col-n09-{n}','name':f'N09.{n}','capacity':4 if n<12 else 12} for n in range(5,24)]
cols=zone_cols+[{'id':f'col-s{n}','name':f'S{n}','capacity':8} for n in list(range(51,63))+list(range(30,51))+list(range(63,81))]
for c in cols:
    if c['name'] in ('S60','S61'): c['smallParcel']=True   # small parcel lanes
cols.append({'id':'col-usps','name':'USPS','capacity':6,'smallParcel':True})   # DHL is not on the board yet
orders=[('SO-40118','FedEx Freight','DOCK-03'),('SO-40122','Old Dominion Freight Line',''),('SO-40131','Estes Express','DOCK-07'),
        ('SO-40140','XPO Logistics','DOCK-01'),('SO-40152','Saia',''),('SO-40160','R+L Carriers','RAMP'),('SO-40163','ABF Freight',''),('SO-40170','FedEx Freight','DOCK-11')]
plan={'S51':[('SO-40140',4,False,2*H)],'S52':[('SO-40140',2,True,2*H),('SO-40163',3,False,5*H)],'S53':[('SO-40118',6,True,30*H)],
      'S54':[('SO-40122',5,False,52*H),('SO-40152',4,False,3*H)],'S55':[],'S56':[('SO-40131',7,False,20*H)],'S57':[('SO-40131',3,True,20*H)],
      'S58':[('SO-40160',8,False,9*D)],'S59':[],'S60':[('SO-40170',2,False,40*60_000)],'S61':[('SO-40152',3,True,3*H)],'S62':[],
      'S30':[('SO-40122',2,False,4*H)],'S31':[('SO-40122',8,False,4*H)],'S32':[('SO-40122',9,False,4*H)],'S45':[('SO-40131',1,False,1*H)],
      'S79':[('SO-40160',4,True,2*H)],'S80':[('SO-40160',6,False,2*H)]}
info={o:(c,d) for o,c,d in orders}
zone_plan={'col-usps':[('SO-40195',3,False,2*H)],'col-w05-90':[('SO-40177',4,False,3*H)],'col-w05-91':[('SO-40177',2,False,3*H)],'col-w06-70':[('SO-40181',3,False,26*H)],
           'col-n09-14':[('SO-40185',12,False,5*H)],'col-n09-15':[('SO-40185',5,True,5*H)],'col-n09-6':[('SO-40190',2,False,60*H)]}
for o,c,d in [('SO-40195','USPS',''),('SO-40177','Saia',''),('SO-40181','Estes Express','DOCK-05'),('SO-40185','Old Dominion',''),('SO-40190','XPO Logistics','')]: info[o]=(c,d)
pallets=[]; n=884100
for lane,groups in plan.items():
    for o,count,dbl,ageMs in groups:
        for i in range(count):
            n+=1; c,d=info[o]
            pallets.append({'id':f'p{n}','slp':f'SLP-{n}','orderNumber':o,'columnId':f'col-s{lane[1:]}','carrier':c,'destination':'',
                            'dockNumber':d,'notes':'','doubleStacked':dbl,'createdAt':now-ageMs-i*60_000,'history':[]})
for cid,groups in zone_plan.items():
    for o,count,dbl,ageMs in groups:
        for i in range(count):
            n+=1; c,d=info[o]
            pallets.append({'id':f'p{n}','slp':f'{o}-{i+1:02d}','orderNumber':o,'columnId':cid,'carrier':c,'destination':'',
                            'dockNumber':d,'notes':'','doubleStacked':dbl,'createdAt':now-ageMs-i*60_000,'history':[]})
shipped=[{'id':f's{i}','slp':f'SLP-77{i:04d}','orderNumber':'SO-40099','shippedAt':now-i*20*60_000,'stagedAt':now-D} for i in range(14)]
state={'columns':cols,'pallets':pallets,'shippedPallets':shipped,'dwellSettings':{'warningDays':1,'overdueDays':2,'overWeekDays':7},
       'docks':[f'DOCK-{i:02d}' for i in range(1,13)]+['RAMP'],'carriers':[]}
gas=subprocess.Popen(['node',E2E+'/fake-apps-script.mjs',REPO+'/Code.gs','8790'],stdout=subprocess.PIPE); gas.stdout.readline()
req=lambda body: json.loads(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8790/exec',data=json.dumps(body).encode(),method='POST')).read())
print('seed:',req({'fn':'saveBoardState','args':[json.dumps(state),''],'key':'ont-e2e','warehouse':'ONT'})['ok'])
# Order Intake ship dates for the "Ship today" card (regular orders only)
import datetime
today=datetime.date.today(); yday=today-datetime.timedelta(days=1)
intake=[{'orderNumber':'SO-40160','customer':'A','shipDate':today.isoformat()},                    # on the floor → to ship
        {'orderNumber':'SO-40131','customer':'A','shipDate':today.isoformat()},                    # on the floor → to ship
        {'orderNumber':'SO-40099','customer':'A','shipDate':today.isoformat()},                    # all shipped → done
        {'orderNumber':'SO-40200','customer':'A','shipDate':today.strftime('%m/%d/%Y')},           # not staged yet → to ship
        {'orderNumber':'SO-40201','customer':'A','shipDate':today.isoformat(),'status':'Cancelled'},  # cancelled → not counted
        {'orderNumber':'SO-40122','customer':'A','shipDate':yday.isoformat()},                     # yesterday, still on floor → late
        {'orderNumber':'SO-40118','customer':'A','shipDate':(today+datetime.timedelta(days=2)).isoformat()},
        # small parcel, due today: not counted
        {'orderNumber':'SPK202611270050','customer':'A','shipDate':today.isoformat()},
        {'orderNumber':'P20261127001','customer':'A','shipDate':today.isoformat()},
        {'orderNumber':'DN-DROP-1','customer':'A','orderType':'dropship','shipDate':today.isoformat()},
        {'orderNumber':'DN-UPS-1','customer':'A','carrier':'UPS_GROUND','shipDate':today.isoformat()},
        {'orderNumber':'DN-FXF-1','customer':'A','carrier':'FedEx Freight','shipDate':today.isoformat()},
        {'orderNumber':'SO-40195','customer':'A','carrier':'USPS','shipDate':yday.isoformat()}]   # small parcel, late: not counted / not red   # freight = regular (not staged)
print('intake:',req({'fn':'upsertOrders','args':[intake,{'enteredBy':'E2E'}],'key':'ont-e2e','warehouse':'ONT'}).get('ok'))
site=http.server.ThreadingHTTPServer(('127.0.0.1',8769),functools.partial(http.server.SimpleHTTPRequestHandler,directory=REPO))
site.RequestHandlerClass.log_message=lambda *a: None
threading.Thread(target=site.serve_forever,daemon=True).start()
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        for (w,h) in [(1920,1080),(1366,768),(390,844)]:
            ctx=await b.new_context(viewport={'width':w,'height':h})
            async def to_gas(route):
                data=route.request.post_data or ''
                resp=await asyncio.to_thread(lambda: urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8790/exec',data=data.encode(),method='POST')).read())
                await route.fulfill(body=resp,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'})
            await ctx.route('https://script.google.com/**',to_gas)
            pg=await ctx.new_page(); errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)))
            await pg.goto('http://127.0.0.1:8769/dashboard.html'); await pg.wait_for_timeout(800)
            signin=await pg.is_visible('#signin')
            await pg.fill('#signin-code','ont-e2e'); await pg.click('#signin-btn'); await pg.wait_for_timeout(2500)
            over=await pg.evaluate("""() => [...document.querySelectorAll('.door .ord, .door .name, .order-span, .order-row .ono, .lane-head .lname, .lane-head .count, .kpi .value')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.trim()).slice(0,10)""")
            if w < 900:
                ph=await pg.evaluate("() => ({phone: document.body.classList.contains('phone'), pageOverflow: document.documentElement.scrollWidth - innerWidth, laneW: Math.round(document.querySelector('#lanes-row .lane').getBoundingClientRect().width), sScrolls: document.querySelector('.sec-s .lane-scroll').scrollWidth > document.querySelector('.sec-s .lane-scroll').clientWidth, kpiFont: getComputedStyle(document.querySelector('.kpi .value')).fontSize})")
                print('    phone layout:', ph)
            print(f'{w}x{h}: signin shown={signin} errors={errs[:2]} truncated={over} sync=', await pg.text_content('#sync-text'))
            info=await pg.evaluate("() => ({docks:[...document.querySelectorAll('.door .name')].map(e=>e.textContent), lanes:document.querySelectorAll('.lane').length, first:document.querySelector('.lane .lname').textContent, laneW:Math.round(document.querySelector('.lane').getBoundingClientRect().width), spans:[...document.querySelectorAll('.order-span:not(.blank)')].map(e=>e.textContent), foot:document.getElementById('floor-foot-right').textContent})")
            print('   ',info)
            chk=await pg.evaluate("""() => {
                const zones=[...document.querySelectorAll('#zones-row .zone .zname')].map(e=>e.textContent);
                const first=document.querySelector('#zones-row .zone');
                const firstLanes=[...first.querySelectorAll('.lane .lname')].map(e=>e.textContent);
                const pcl=[...document.querySelectorAll('.lane.parcel .lname')].map(e=>e.textContent);
                const staged=getComputedStyle(document.querySelector('.tile:not(.docked):not(.late-order):not([class*=lvl-w]):not([class*=lvl-o])')).backgroundColor;
                // every tile in a 2x spot has the same height
                const halves=[...document.querySelectorAll('#lanes-row .spot.filled')].filter(s=>s.querySelectorAll('.tile').length===2).map(s=>[...s.querySelectorAll('.tile')].map(t=>Math.round(t.getBoundingClientRect().height)));
                const lone=document.querySelectorAll('.tile.open-half').length;
                const sRow=[...document.querySelectorAll('#lanes-row .lane .lname')].map(e=>e.textContent);
                const fl=document.querySelector('.floor').getBoundingClientRect(), st=document.getElementById('stage').getBoundingClientRect();
                const ship=document.getElementById('kpi-ship');
                const stack=document.querySelector('.zone-stack');
                const stackNames=stack ? [...stack.querySelectorAll('.zname')].map(e=>e.textContent) : [];
                const zr=[...document.querySelectorAll('#zones-row > *')].map(e=>Math.round(e.getBoundingClientRect().width));
                return {ship: ship ? ship.querySelector('.label').textContent + ' | ' + ship.querySelector('.value').textContent + ' | ' + ship.querySelector('.note').textContent : null,
                    lateTiles: document.querySelectorAll('.tile.late-order').length,
                    lateTileOrders: [...new Set([...document.querySelectorAll('.tile.late-order')].map(t => t.title.split(' · ')[1]))],
                    lateSpan: [...document.querySelectorAll('.order-span.late')].map(e => e.title),
                    shipStandsOut: ship ? ship.classList.contains('todo') && getComputedStyle(ship).backgroundColor !== getComputedStyle(document.querySelector('.kpi:not(#kpi-ship)')).backgroundColor : false, stackNames, zoneWidths: zr,
                    zones, firstLanes, sHasParcel: sRow.includes('S60') || sRow.includes('S61'), aside: !!document.querySelector('aside'),
                    kpis:[...document.querySelectorAll('.kpi .label')].map(e=>e.textContent), ver: document.getElementById('app-ver').textContent,
                    floorToBottom: Math.round((st.bottom - fl.bottom) / (st.height / 1080)), dhlDim: first.querySelectorAll('.lane')[1]?.style.opacity, pcl, staged, halvesSame: halves.every(h=>Math.abs(h[0]-h[1])<=1), twoXHeights:[...new Set(halves.flat())], lone,
                    bad: [...document.querySelectorAll('#lanes-row .spot.filled')].filter(s=>s.querySelectorAll('.tile').length===2).map(s=>[s.closest('.lane').querySelector('.lname').textContent, ...[...s.querySelectorAll('.tile')].map(t=>t.className+':'+t.getBoundingClientRect().height.toFixed(1))]).filter(x=>Math.abs(parseFloat(x[1].split(':')[1])-parseFloat(x[2].split(':')[1]))>1).slice(0,4)};
            }""")
            ok = (chk['zones'][:4]==['Parcel','N09','W05','W06'] and chk['stackNames']==['W05','W06']
                  and chk['ship']=='Ship today | 4+1 late | of 5 due · 29 plts on floor · 24 late plts' and chk['shipStandsOut']
                  and chk['lateTiles']==24 and chk['lateTileOrders']==['SO-40122'] and 'SO-40122' in chk['lateSpan'] and chk['firstLanes']==['USPS','DHL','S60','S61'] and chk['dhlDim']=='0.45'
                  and not chk['sHasParcel'] and not chk['aside'] and chk['ver'].startswith('v1.')
                  and any('Dwell' in k for k in chk['kpis']) and 'Staged today' in chk['kpis'] and (w < 900 or chk['floorToBottom'] <= 20)
                  and {'S60','S61','USPS'} <= set(chk['pcl']) and chk['staged'] in ('rgb(21, 128, 61)',) and chk['halvesSame'] and chk['lone']>=1)
            print(f"    {'PASS' if ok else 'FAIL'} Parcel block (USPS, DHL, S60, S61) left of N09, no bottom cards, dwell + staged today on top, version, floor fills the screen, dark-green staged, equal 2x halves:", chk)
            await pg.screenshot(path=f'{E2E}/out/dashboard_{w}x{h}.png', full_page=(w < 900))
            # Theme button switches to dark and back
            await pg.click('#theme-btn'); await pg.wait_for_timeout(300)
            dark=await pg.evaluate("document.body.classList.contains('dark')")
            await pg.screenshot(path=f'{E2E}/out/dashboard_{w}x{h}_dark.png')
            await pg.keyboard.press('t'); await pg.wait_for_timeout(200)
            light=not await pg.evaluate("document.body.classList.contains('dark')")
            print(f'    theme switch: dark={dark} back_to_light={light}')
            if w == 1920:
                # "Small parcel orders" ticked on the staging page (shared in the board) → late small parcel counted too
                st2=dict(state); st2['shipTodaySettings']={'parcelLate': True}
                req({'fn':'saveBoardState','args':[json.dumps(st2)],'key':'ont-e2e','warehouse':'ONT'})   # no base: overwrite
                await pg.reload(); await pg.wait_for_timeout(3500)
                on=await pg.evaluate("[document.querySelector('#kpi-ship .label').textContent, document.querySelector('#kpi-ship .late-chip')?.textContent, document.querySelector('#kpi-ship .late-chip')?.title]")
                ok2 = on[0]=='Ship today+PCL' and on[1]=='+2 late' and 'SO-40195' in on[2] and 'incl. 1 small parcel' in on[2]
                print(f"    {'PASS' if ok2 else 'FAIL'} parcel reminder ticked: late small parcel counted on the card:", on)
                req({'fn':'saveBoardState','args':[json.dumps(state)],'key':'ont-e2e','warehouse':'ONT'})
                await pg.reload(); await pg.wait_for_timeout(3500)
                # A search on the staging page → the matching lanes flash here for ~12 s
                req({'fn':'flashLanes','args':[{'kind':'order','label':'SO-40122','lanes':['S30','S31','S32','S54']}],'key':'ont-e2e','warehouse':'ONT'})
                await pg.evaluate('refresh()'); await pg.wait_for_timeout(1500)
                fl=await pg.evaluate("({lanes:[...document.querySelectorAll('.lane.flash .lname')].map(e=>e.textContent), banner: document.getElementById('flash-banner').classList.contains('on') ? document.getElementById('flash-banner').textContent : ''})")
                await pg.screenshot(path=f'{E2E}/out/dashboard_flash.png')
                ok3 = fl['lanes']==['S30','S31','S32','S54'] and 'Order SO-40122 · 4 lanes' in fl['banner']
                print(f"    {'PASS' if ok3 else 'FAIL'} search on the staging page flashes the matching lanes + banner:", fl)
                await pg.evaluate('refresh()'); await pg.wait_for_timeout(500)
                again=await pg.evaluate("document.querySelectorAll('.lane.flash').length")
                await pg.wait_for_timeout(12500)
                gone=await pg.evaluate("document.querySelectorAll('.lane.flash').length === 0 && !document.getElementById('flash-banner').classList.contains('on')")
                print(f"    {'PASS' if (again==4 and gone) else 'FAIL'} the same flash isn't restarted by the next refresh and stops after ~12 s:", again, gone)
            await ctx.close()
        await b.close()
os.makedirs(os.path.join(E2E, 'out'), exist_ok=True)
asyncio.run(main()); gas.terminate(); site.shutdown()
