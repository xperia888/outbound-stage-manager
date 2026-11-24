"""Seeds a realistic board into the in-memory sheet, opens dashboard.html at TV sizes,
signs in, and checks for page errors and cut-off labels. Screenshots go to out/."""
import asyncio, functools, http.server, threading, json, subprocess, time, urllib.request, random
from playwright.async_api import async_playwright
import os
E2E=os.path.dirname(os.path.abspath(__file__)); REPO=os.path.abspath(os.path.join(E2E, '..', '..'))
now=int(time.time()*1000); H=3600_000; D=24*H
random.seed(7)
cols=[{'id':f'col-s{n}','name':f'S{n}','capacity':8} for n in list(range(51,63))+list(range(30,51))+list(range(63,81))]  # same order as the real board
orders=[('SO-40118','FedEx Freight','DOCK-03'),('SO-40122','Old Dominion Freight Line',''),('SO-40131','Estes Express','DOCK-07'),
        ('SO-40140','XPO Logistics','DOCK-01'),('SO-40152','Saia',''),('SO-40160','R+L Carriers','RAMP'),('SO-40163','ABF Freight',''),('SO-40170','FedEx Freight','DOCK-11')]
plan={'S51':[('SO-40140',4,False,2*H)],'S52':[('SO-40140',2,True,2*H),('SO-40163',3,False,5*H)],'S53':[('SO-40118',6,True,30*H)],
      'S54':[('SO-40122',5,False,52*H),('SO-40152',4,False,3*H)],'S55':[],'S56':[('SO-40131',7,False,20*H)],'S57':[('SO-40131',3,True,20*H)],
      'S58':[('SO-40160',8,False,9*D)],'S59':[],'S60':[('SO-40170',2,False,40*60_000)],'S61':[('SO-40152',3,True,3*H)],'S62':[],
      'S30':[('SO-40122',2,False,4*H)],'S31':[('SO-40122',8,False,4*H)],'S32':[('SO-40122',9,False,4*H)],'S45':[('SO-40131',1,False,1*H)],
      'S79':[('SO-40160',4,True,2*H)],'S80':[('SO-40160',6,False,2*H)]}
info={o:(c,d) for o,c,d in orders}
pallets=[]; n=884100
for lane,groups in plan.items():
    for o,count,dbl,ageMs in groups:
        for i in range(count):
            n+=1; c,d=info[o]
            pallets.append({'id':f'p{n}','slp':f'SLP-{n}','orderNumber':o,'columnId':f'col-s{lane[1:]}','carrier':c,'destination':'',
                            'dockNumber':d,'notes':'','doubleStacked':dbl,'createdAt':now-ageMs-i*60_000,'history':[]})
shipped=[{'id':f's{i}','slp':f'SLP-77{i:04d}','orderNumber':'SO-40099','shippedAt':now-i*20*60_000,'stagedAt':now-D} for i in range(14)]
state={'columns':cols,'pallets':pallets,'shippedPallets':shipped,'dwellSettings':{'warningDays':1,'overdueDays':2,'overWeekDays':7},
       'docks':[f'DOCK-{i:02d}' for i in range(1,13)]+['RAMP'],'carriers':[]}
gas=subprocess.Popen(['node',E2E+'/fake-apps-script.mjs',REPO+'/Code.gs','8790'],stdout=subprocess.PIPE); gas.stdout.readline()
req=lambda body: json.loads(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8790/exec',data=json.dumps(body).encode(),method='POST')).read())
print('seed:',req({'fn':'saveBoardState','args':[json.dumps(state),''],'key':'ont-e2e','warehouse':'ONT'})['ok'])
site=http.server.ThreadingHTTPServer(('127.0.0.1',8769),functools.partial(http.server.SimpleHTTPRequestHandler,directory=REPO))
site.RequestHandlerClass.log_message=lambda *a: None
threading.Thread(target=site.serve_forever,daemon=True).start()
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        for (w,h) in [(1920,1080),(1366,768)]:
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
            print(f'{w}x{h}: signin shown={signin} errors={errs[:2]} truncated={over} sync=', await pg.text_content('#sync-text'))
            info=await pg.evaluate("() => ({docks:[...document.querySelectorAll('.door .name')].map(e=>e.textContent), lanes:document.querySelectorAll('.lane').length, first:document.querySelector('.lane .lname').textContent, laneW:Math.round(document.querySelector('.lane').getBoundingClientRect().width), spans:[...document.querySelectorAll('.order-span:not(.blank)')].map(e=>e.textContent), other:document.getElementById('other-lanes').textContent})")
            print('   ',info)
            await pg.screenshot(path=f'{E2E}/out/dashboard_{w}x{h}.png')
            await ctx.close()
        await b.close()
os.makedirs(os.path.join(E2E, 'out'), exist_ok=True)
asyncio.run(main()); gas.terminate(); site.shutdown()
