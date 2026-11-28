# outbound-stage-manager

Outbound pallet management app: ONUS-ONT Outbound Pallet Staging Manager (v2). A single-page web app for managing outbound pallet (SLP) staging lanes on the warehouse floor, with an optional Google Sheets backend for multi-device sync.

## Features

- Staging board for lanes S51–S62 (configurable), with floor-spot capacity and 2-high double-stack support (2 stacked pallets = 1 floor spot)
- Add a shipment by scanning or typing the order number and entering the number of pallets (no SLP barcodes)
- Drag and drop pallets or whole orders between lanes
- Orders overview, whole-order editing, loading dock assignment, ship order
- Dwell-time alerts (warning / overdue / over a week) with snooze
- Find Space finder and Smart Consolidate plan (no order blocking)
- End of Day report with CSV export and print
- JSON backup and restore

## Files

| File | Purpose |
|---|---|
| `index.html` | The full app (HTML, Tailwind CSS, JavaScript) |
| `Code.gs` | Apps Script backend: serves the page, stores board state in the `StateChunks` tab and writes the `Scan Log` tab |
| `tests/board-sync.test.mjs` | Tests for sync, merge, scan log and handler escaping (`node --test`) |
| `dashboard.html` | Big-screen TV dashboard (read-only, auto-refresh) |
| `intake.html` | Order Intake portal for customer service: new orders, WMS import, API connector |
| `tests/e2e/` | Browser click-through tests (`npm test`) and `dashboard_check.py` |

## One board on every link

Both links show the same board, stored in one Google Sheet:

- **GitHub Pages** (`https://xperia888.github.io/outbound-stage-manager/`): talks to the sheet through the Apps Script web-app URL set in `CLOUD_API_URL` in `index.html`. Phone camera scanning works here.
- **Apps Script web-app link** (ends in `/exec`): talks to the sheet directly.

Every device asks for the **access code** once, then remembers it. Without `CLOUD_API_URL`, or when opening the file directly, the app runs in **Local Mode**, where the board is saved in that browser only.

## Warehouses (ONT and CHINO)

Each warehouse has its own board, access code, Scan Log tab and saved data on each device. Switch with the warehouse selector in the header. Chino is amber, so it's easy to tell apart.

| Warehouse | Link | Access code (Script Property) | Sheet tabs |
|---|---|---|---|
| ONUS-ONT | `https://xperia888.github.io/outbound-stage-manager/` (or `?wh=ONT`) | `ACCESS_CODE` | `StateChunks`, `Scan Log` |
| ONUS-CHINO | `https://xperia888.github.io/outbound-stage-manager/?wh=CHINO` | `ACCESS_CODE_CHINO` | `StateChunks CHINO`, `Scan Log CHINO` |

**The access code picks the warehouse.** Open the normal link and enter your code: the ONT code opens ONUS-ONT, and the Chino code opens ONUS-CHINO. A device remembers its warehouse and code after that. A code only opens its own warehouse. The header switcher and `?wh=` links still work for people who have both codes. Keep the two codes different.

## Setup

1. Create or open a Google Sheet, then go to **Extensions → Apps Script**.
2. Replace `Code.gs` with this repo's `Code.gs`.
3. Add an HTML file named **`Index`** and paste in `index.html`.
4. Set the access codes: **Project Settings (gear) → Script Properties → Add script property**. Add `ACCESS_CODE` for ONT and `ACCESS_CODE_CHINO` for Chino, each with a different value of your choice. Share each code only with that warehouse's staff.
5. **Deploy → New deployment → Web app**, with **Execute as: Me** and **Who has access: Anyone**. The access code is what keeps outsiders out. Approve the permissions Google asks for. To update later, use **Manage deployments → Edit → Version: New version**, which keeps the same URL.
6. Copy the web-app URL (ends in `/exec`), paste it into `const CLOUD_API_URL = '...';` in `index.html`, and commit. GitHub Pages republishes within a minute or two.

Board state is saved to the `StateChunks` tab, split across rows to stay under the 50,000-character cell limit. Data from the old single-cell `State!A1` layout is read once if `StateChunks` is empty.

## TV dashboard

`https://xperia888.github.io/outbound-stage-manager/dashboard.html` is a full-screen live view for a big-screen TV:
- **Layout:** it follows the warehouse floor, left to right.
  - **Loading doors:** D9 → D1, then the ramp. Each shows the order being loaded, its carrier, pallet count and the lanes it's coming from.
  - **Staging lanes:** every lane named S + number (now S30–S80) in **one line**, as on the floor. Each lane is a column of floor spots, with every pallet in its spot, 2x stacks split in two, dwell alerts (⚠ aging, ⏱ overdue, ⛔ over a week), and the door it's assigned to underneath.
  - **Parcel block:** USPS, DHL and every lane ticked "Small parcel lane" (e.g. S60, S61 — they leave the S line) in one block, left of N09.
  - **Other zones:** N09, W05 and W06 locations sit in a row under the S lanes, filling the bottom of the screen. Parcel and N09 get the full height; **W05 and W06 are stacked** (they hold fewer pallets, so their lanes get wider) — a list inside `FLOOR_LAYOUT.zones` stacks zones, one block per zone, in location-number order. Locations holding 12 show their spots in two columns. Zones are set in `FLOOR_LAYOUT.zones`.
  - **Order line:** a bracket under the lanes shows which order sits in which lanes.
  - **New lanes:** lanes added in the app appear on the dashboard automatically.
- **Top cards:** pallets staged, floor spots used, open orders, orders at dock, **dwell** (⚠ aging · ⏱ overdue · ⛔ over a week, with the oldest pallet and its lane), **ship today** (amber, glowing, so it stands out: the **regular** orders whose Ship / appt date in Order Intake is today and that aren't fully shipped, of all regular orders due today, and their pallets on the floor; small parcel is not counted — Order # SPK… or P + digits, drop ship, UPS / FedEx / USPS / DHL; it turns green with ✓ when all have shipped; a red **+N late** shows regular orders past their ship date that haven't shipped, and their pallets on the floor are drawn **red with a "!"** (striped, so they aren't mistaken for ⛔ over a week) with a red order label under the lanes; Order Intake is read once a minute), staged today and shipped today. Locations not on the plan and other docks in use are in the footer line.
- **Version:** shown next to the warehouse name (`APP_VERSION` in `dashboard.html`).
- **Updates:** it refreshes every 10 seconds and warns if the connection drops.
- **Read-only:** it never changes the board.
- **Sign in:** enter the access code once on the TV. The code picks the warehouse.
- **Screen size:** it's designed for 1920×1080 and scales to fit any screen.

- **Theme:** the dashboard uses the Outbound Staging app's colours (slate, amber, sky) in both light and dark. The **Dark theme / Light theme** button in the header switches the look, and each screen remembers its choice. You can also press **T** or open `dashboard.html?theme=dark`.

To change the doors or their order, or to flip the lane direction (lowest number on the right), edit `FLOOR_LAYOUT` near the top of `dashboard.html`.

## Order Intake portal (`intake.html`)

Customer service releases orders to the warehouse here: https://xperia888.github.io/outbound-stage-manager/intake.html

- **Separate from staging:** each order is one row in an **Orders** tab per warehouse (`Orders`, `Orders CHINO`, `Orders TEST`). The staging board, app and dashboard are not changed.
- **Fields:**
  - Order # (must match what the floor scans)
  - Customer
  - **Release date** and **release time window**. The time is a drop-down of the CS hand-out windows: `8:30am-10:00am`, `10:00am-12:00pm`, `12:30pm-14:00pm`, `14:00pm-16:00pm` (same as the CS sheet).
    - A new order starts on today and the current window. Outside the windows, pick one.
    - Saved as **Released to Warehouse** = date + window start, plus a **Release Window** column with the label.
    - Older orders outside every window keep their exact time ("Other: 5:10 PM").
    - **Import:** the Release time slot takes the window labels as written in the CS sheet (spaces don't matter), or a plain time, which is put in its window and keeps the exact time. A file with one date-and-time column goes on Release date. Older matchings and templates still work.
    - The **End of Day** report shows orders released by time window.
  - Cartons, expected pallets and picker
  - Reference type + reference (ARN#, Repack, PO#…)
  - Order type
  - **Order ready date** (when the order is picked and ready); it is matched automatically during import from columns such as "Ready Date" or "Order Ready"
  - Carrier, SCAC, PRO/BOL, VRID, ship/appointment date
  - Destination, notes
  - Status, source, entered by, created/updated (kept by the server)
  - Picker and VRID are the last two columns of the Orders tab; older tabs get them added automatically
  - **Order Ready Date** is added as the last column of the Orders tab; older tabs get it added automatically
- **Order list:** shows each order's floor progress, read from the staging board (read only): waiting, partly staged, staged, at dock, or shipped, with lanes and counts. You can search, filter and export to CSV.
- **Stage lanes from the floor:** orders are matched to the staging board by Order #.
  - The list has a **Stage Lane** column, live from the board; grey chips mean the order's last lanes after it shipped.
  - The Orders tab gets **Stage Lanes**, **Dock**, **Pallets On Floor**, **Pallets Shipped** and **Floor Updated** columns.
  - These columns are filled in whenever the floor changes the board, when the intake page refreshes, or when an order is entered that the floor had already staged.
- **Cancel:** marks the row Cancelled. Rows are never deleted, so there's always a history, and a cancelled order can be restored.
- **Import from WMS (any Excel or CSV):**
  - Load any export. Pick the **sheet** and the **header row**; title rows above the headers are found automatically.
  - **Drag** each file column onto an order field, or **tap** a column and then a field (phones). Drop two columns on one text field to combine them, e.g. City + State → Destination. Click × to remove a match.
  - Columns are auto-matched by name where possible (e.g. "Delivery #" → Order #).
  - **If empty, use** fills a value for empty cells (e.g. Carrier = Amazon Freight).
  - **Templates:** **Save as template…** stores the matching, defaults, sheet and header row under a name (e.g. "Amazon VRID report") in the **Import Templates** tab. Everyone in that warehouse can use it. When a file with the same columns is loaded, its template is applied automatically. Templates can be updated or deleted.
  - Rows are checked before importing (new, update, skip, problem). Existing orders are updated by Order #, and blank cells never wipe what was already entered.
- **API connector:** a WMS or a small script can POST orders as JSON. The **API Connector** tab has the exact request format.
- **Order list:** each Order # has a **copy** button. Under each status the list shows the matching date: **On floor since** the first pallet was staged (Staged, Partly staged, At dock), or when it **shipped** (last pallet out; "Last shipped" for a part-shipped order). Hover for the exact time and how long. The CSV export has *Staged on floor at* and *Shipped at* columns.
- **Summary tiles** follow the search box, so their totals cover only the matching orders. The **Missing carrier** tile counts open orders (not shipped or cancelled) with no carrier. Click it to list them; they show **No carrier** in the table.
- **Any screen size:** works from phones up to ultra-wide monitors. On a regular laptop (1280-1536px wide) every table fits without sideways scrolling. The order list combines related columns (Order # / Type, Plt / Ctn, Ready / Ship) and long text wraps. On screens 2200px wide and up the page gets wider and scales up a little.
- **Name on the sign-in page.** Sign-in asks for the access code and your name. Signing out clears the name, so the next person enters their own. The server refuses orders saved without a name (the WMS API key is exempt). The name is saved in two columns:
  - **Created By:** set once, when the order is first created.
  - **Entered By:** whoever saved the order last.
- **Version:** the header shows the page version (`APP_VERSION` in `intake.html`, raised with each change).
- **Bulk delete** (Orders list → **☐ Select**): tick orders (or all shown), or pick an **import batch** — orders saved together, by created time, person and source — then **Delete selected…** and type `DELETE`. CS code only (not the floor code or the WMS API key). Orders with pallets on the floor or shipped are never deleted. Each deleted row is copied first, with who and when, to the **"Orders Deleted"** tab (one per warehouse), so it can be pasted back if needed.
- **Picker names** (API Connector tab): the WMS gives the picker's PDA account (e.g. `picker4`). List who uses each account, per warehouse (Script Property `PICKER_NAMES` / `PICKER_NAMES_CHINO`). Any order saved with an account as Picker (WMS pull, file import, the form, the WMS API) is saved with the person's name; orders already saved with an account show the name (account underneath) without changing them, and the reports count by name. Accounts on orders that have no name yet are offered for quick adding.
- **WMS warehouse (wh_no):** choose it in the API Connector before pulling. Test connection lists the warehouses the WMS sent (with counts); **Pull orders** and **Fill missing pickers** refuse to run until one is chosen, and use only that warehouse's orders and picking tasks. Choosing a warehouse other than the page's own (e.g. ONUS-CHINO on the ONT page) asks first. A WMS that sends no `wh_no` isn't blocked.
- **WMS speed:** order pages are asked for 5 at a time, and the picking-task query goes out together with the first pages. WMS actions wait up to 6 minutes (the Apps Script limit) with a running timer, and Test connection shows how long it took.
- **Pull orders from the WMS** (API Connector tab): Apps Script reads orders from the WMS API and they go through the same import matching. **A WMS pull only adds new orders.** Orders already in Order Intake are skipped and never changed, the server enforces this, and the Orders tab is copied to "Orders backup …" first (newest 3 kept).
  - **ONUS WMS:** press **Use ONUS WMS settings** (POST `/api/outbound/query`, `startRow`/`endRow` paging, SHIPPED / CANCELLED left out, sign-in through the WMS login API), enter your WMS username and password and press **Sign in to WMS**, then **Test connection** and **Pull orders**. **Order #:** regular orders use the DN number (`outbound_no`); **small parcel** orders (drop ship orders, or carrier UPS / FedEx / USPS / DHL, not "… Freight") use the **pick list number** (`pickinglist_no_byproduct`, SPK…) so CS can follow the picking. DNs on the same pick list become one order (cartons and pallets added up, POs joined, earliest ship-by date, the DNs listed in Notes). A small parcel DN with no pick list yet (not committed in the WMS) is left for a later pull, and a pick list whose DN is already in Order Intake is left out so the shipment isn't entered twice. **Fill missing pickers** matches by the same Order #. **Released to Warehouse = the committed date:** an order is committed in the WMS when its picking task is created, so the release date and time come from that task's `created_at` (used as the WMS gives it — a time with a zone is shown in local time, one without is not shifted), and the Release Window is the CS window that time falls in (blank outside the windows). Orders not committed yet — no pick list (no SPK… number: the field blank, left out of the answer, or a placeholder like `-`, `N/A`, `null`), or no picking task when the task API is set — are left out and come in on a later pull. Small parcel is also recognised from WMS codes like `UPS_GROUND` and parcel SCACs (UPSN, FDEG, FDXG, USPS, DHL…); freight / LTL is not. The rest of the built-in matching (`order_no` is the WMS's own OB… number): `owner_name` → Customer, `ttl_box` → Cartons, `ttl_pallet` → Pallets, `carrier_name`/`scac`/`bol_no`, `po_no` → Reference (PO#), `outbound_type` → Order type, `ship_no_later` → Ship date, consignee city + state → Destination. Save it as your own template to change it: the next pull uses the template last saved or chosen on a WMS pull (on that device; otherwise the best template saved from a pull), even after a page reload. It's applied as long as its Order # column is in the pull. Fields that only some pulls have (e.g. `parcel_dns`) are just listed as "not in this pull".
  - **Picker from pick tasks** (ONUS Outbound Task Query, same token), following the "Outbound & Picker Data Integration Rules":
    - Each outbound's `pickinglist_no_byproduct` is matched to the one PICKING task with that `group_no`. The task's `assigned_to` is the Picker, and every outbound on that pick list gets it.
    - Pulled records gain `picker_name`, `picker_id`, `picking_task_id`, `picking_task_status`. Without a task they stay empty; no other user field is used instead.
    - Two picking tasks on one pick list are reported in `picker_exception`, and no picker is chosen.
    - Pick tasks only exist once the order is committed. **Fill missing pickers…** lists the orders already in Order Intake that can get a picker, then writes **only the blank Picker cells**. A picker already entered is never overwritten, and nothing else changes.
  - **WMS login** sign-in type (WMS login API, `POST /api/login` with `username`, `password`, `client: "web_client"`): Apps Script exchanges the username + password for a Bearer token. The password goes straight to the WMS and is **never saved or logged**; only the token is kept in Script Properties (never sent to the browser). The token is found at the usual places (`token`, `access_token`, `data.token`, `data.user.token`, …, a leading `Bearer ` removed) or at **Where the token is**; if none matches, the error lists the answer's field names only. When the WMS answers 401 the token is dropped and the page asks you to sign in again. After 5 failed sign-ins in 15 minutes sign-in pauses so a wrong password can't lock the WMS account. The WMS shows only the warehouse of the signed-in account, so ONT and CHINO each sign in with their own account. The production login address is assumed to be on the same host as the outbound query (`https://prd-onus.target-ai.com:18890/api/login`); change **WMS login address** if the WMS team says otherwise.
  - Any other WMS: API address, GET/POST + body, sign-in (header key, Bearer, username + password, WMS login, key in the address, OAuth2 client credentials), where the orders are, paging, and a rule to leave records out.
  - The key / token is stored in Script Properties (`WMS_PULL_SECRET`, `_CHINO`) and never sent back to the page. Enter it only in the page.
- **Reports** tab (floor leads and customer service), with **Export CSV** and **Print / PDF**. Each report combines intake orders with the staging floor history from the **Scan Log** and the live board:
  - **End of Day** (pick a day; default is today):
    - Totals: orders released, pallets and cartons released, pallets staged, pallets shipped, orders completed, and orders still open.
    - Floor activity by hour.
    - Shipped orders, with dock, last pallet out and the time from release to shipped.
    - Orders still open at end of day, with their age and stage lanes.
    - **By user:** orders each person created (with pallets and cartons), other orders they edited, orders they cancelled, and their pallets shipped that day.
    - Orders released, by customer and by picker.
    - Exceptions: orders waiting more than 24h, over/short shipments, cancelled orders still on the floor, and floor orders that are missing from intake.
  - **Order Lifecycle** (pick a date range, or a 7 days / 30 days / This month shortcut): every order released in the range, with each milestone:
    - Released, first staged, at dock and shipped.
    - The time between milestones.
    - Pallets expected vs staged vs shipped.
    - **Created by** for each order, and a **By user** summary: orders, pallets, cartons, shipped complete and average release → shipped.
    - Averages for the whole range and for each customer.

**Access (Script Properties):**

| Property | Who | Can do |
|---|---|---|
| `ACCESS_CODE` / `ACCESS_CODE_CHINO` | Floor leads | Everything, including the portal |
| `CS_CODE` / `CS_CODE_CHINO` | Customer service | Orders and reports; cannot change the staging board |
| `WMS_API_KEY` / `WMS_API_KEY_CHINO` | The WMS connection | `upsertOrders` and `listOrders` only; not a sign-in code |

**Setup:** update `Code.gs` in Apps Script, add the properties you need, then use **Deploy → Manage deployments → Edit → New version**. The `Orders` tab is created on the first save.

## Adding a shipment

No SLP barcodes are needed. A shipment is an order number plus a number of pallets.
- **Select Order** (header button): lists the orders customer service released in Order Intake that still have pallets to stage, oldest first.
  - Each entry shows the customer, carrier, reference, pallets left and progress.
  - Tap an order, or scan or type its number into the search box and press Enter.
  - The pallet count is prefilled with what's left, and a lane is suggested. **Add Shipment** stages them.
  - Carrier and destination come from the intake order.
  - Fully staged and cancelled orders drop off the list. The list refreshes every minute.
  - **Order not listed? Scan / type it** opens the scan window for orders that aren't in Order Intake.

- **Quick bar:** scan or type the order number and press Enter. The cursor jumps to **Pallets**; type the count and press Enter.
- **Scan Order:** the same with the camera. Scanning the order barcode fills in the order number, then you enter the number of pallets. Carrier and destination can be added here.
- **Pallet labels:** each pallet gets a label from the order number, e.g. `SO-41200-01`, `SO-41200-02`. Numbering carries on when more pallets are added to the same order later.
- **Lane:** the lane box picks a lane automatically (same order first, then an empty lane), or choose one yourself.
- **Edit order:** use **Add pallets** to add more to an existing order.

## Smart lane suggestion (short lanes first)

**Auto** in the quick bar, **Select Order** and **Find Space** suggest a lane for the whole shipment, using the number of pallets and whether they are single or 2x stacked (2x = 2 pallets per floor spot). The order of preference:

1. The lane already holding this order, if it takes the whole shipment.
2. Small parcel orders: a parcel lane that takes it all.
3. The **shortest empty lane** (smallest capacity) that takes it all, leaving as few spots unused as possible.
4. The order is already on the floor but its lane is too small: keep going in its own lane; the rest is spread over the next lanes.
5. Any lane that takes it all (least left over).
6. Nothing takes it all: start in the lane with the most room; the rest is spread over the next lanes.

Pallet count used:
- **Quick bar:** the Pallets box, or what Order Intake says is still left. Changing the count or 2x re-suggests, but a lane you picked by hand stays until you change the order or press **Auto**.
- **Select Order:** the "Pallets to stage now" box.
- **Find Space:** "Pallets to Stage", with the new default sort **Best Fit (short lanes first)**. The top lane is marked ★ Best fit.

## Small parcel lanes

Open a lane's settings (the sliders icon) and tick **Small parcel lane**. The lane gets a purple **PARCEL** badge.

- **Suggestions:** a parcel lane is only suggested for orders whose carrier is **UPS, FedEx, USPS or DHL**. The carrier comes from the order's pallets or Order Intake. The freight services of those companies (e.g. "FedEx Freight") count as regular freight.
- Small parcel orders try parcel lanes first, after their own lane, and fall back to regular lanes when the parcel lanes are full.
- When a big shipment is spread over several lanes, a regular order never spills into a parcel lane. You can still pick a parcel lane yourself.
- **Find Space:** with an order typed in, parcel lanes only show for small parcel orders. With no order, they show last, marked "Small parcel only".
- **Consolidate:** leaves small parcel pallets and parcel lanes alone (nothing is moved out of or into them).
- **Ship Today** (header button next to **Alerts**): **regular** orders whose **Ship / appt date** in Order Intake is today and that **haven't shipped yet**, with their status on the board — *Not staged yet*, *On floor* (pallets, lanes) or *At dock* — plus orders from an earlier date that still haven't shipped (**late**, listed first, in red). **Locate** highlights the order on the board. Small parcel orders are not listed (Order # starting with SPK or P + digits, drop ship, or a UPS / FedEx / USPS / DHL carrier), and shipped orders drop off the list. Tick **Small parcel orders** in the Ship Today window to also be reminded of **late** small parcel orders (past their ship date, not shipped). They're tagged "Small parcel" and added to the late count. The choice is saved in the board (`shipTodaySettings.parcelLate`), so every staging device and the TV dashboard follow it: the dashboard's Ship today card then shows **+PCL**, counts late small parcel orders in **+N late**, and draws their pallets red. The button shows the regular orders left (+ late) and turns amber while orders are left, red when any are late, green when all of today's shipped. Order Intake is re-read every minute. Dates like `2026-11-27`, `11/27/2026` or `11/27` are understood.
- **Version:** the header badge shows the app version (`APP_VERSION` in `index.html`).
- **Live dashboard:** parcel lanes have a violet top bar and a **PCL** tag in place of the count. **USPS**, **DHL** and all small parcel lanes share the **Parcel** block to the left of N09. Add them in the staging app with exactly those names (and tick Small parcel lane); until then they show dimmed.

## Search by location

The board's search box also finds **locations**. Type a lane name, or the start of one, to show just those lanes with all their pallets, empty lanes included. Each lane found is outlined in blue.

- `S55`, or just `55`, shows lane S55.
- `s5` shows S50–S59.
- `N09` shows every N09 location; `w06.7` shows W06.70–W06.79.
- Order #, pallet, carrier and dock searches work as before.

## Locate

**Locate** (in Alerts, Consolidate, or a card's order chip) makes the order's cards glow amber and lifts them above the rest, outlines its lanes, and fades every other card. Clear it with the **×** on the "Highlighted Order" chip.

## Pallet age on cards

Each pallet card shows how long that pallet has been on the floor: minutes, then hours, then days + hours (`2d 14h`). The colour follows the dwell alert levels: grey when normal, amber when aging, red when overdue, purple when over a week. In **Grouped** view, each order card shows **Age** = the age of the order's oldest pallet on the floor.

## Lane capacity

When a shipment doesn't fit in the chosen lane, the page offers to spread it over the next lanes in number order, for example "S52 has room for 8 of 12 pallets. Spread SO-41200 over S52 (8), S54 (4)?". It uses empty lanes, or lanes holding only that order, before lanes with other orders. 2x-stacked pairs count as one spot.
- **Spread over lanes** places them.
- **Cancel** adds nothing.
- If there isn't room anywhere, it warns instead, for example "S52 would use 20 of 8 floor spots. Put it there anyway?". **Put it anyway** puts them all in that lane.
- Moving pallets into a full lane gives the same over-capacity warning.

## Multi-device sync

Each save sends the cloud version the device last saw. If another device saved in the meantime, the server returns its board instead of overwriting it. The page then merges the two boards, keeping scans, moves and shipments from both devices, and saves again. A pallet shipped on one device stays shipped even if another device edited it.

## Scan Log

When running from Apps Script, every action is also written as a row in the sheet's **Scan Log** tab (created automatically):

| Timestamp | Action | SLP | Order | From Lane | To Lane | Stack | Carrier | Destination | Dock | Device | User | Event ID |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

Actions: `SCAN`, `MOVE`, `CONSOLIDATE`, `DOCK`, `SHIP` (To Lane = dock), `REMOVE`.

- Events wait in a queue saved on the device and are sent in batches. If the connection drops, they are retried until the sheet confirms them, so nothing is lost when wifi drops.
- Retried events are never written twice (matched by Event ID).
- **Device** is a short ID saved in each browser (for example `Android-K3F9`). **User** is the Google account email, which Google only provides when the web app runs as the user accessing it, or within your Workspace domain.
- SLP and order codes are stored as text, so leading zeros are kept.

## Test board (writes test data to the sheet safely)

`…/outbound-stage-manager/?wh=TEST` opens **ONUS-TEST**, a separate board for trying things out. It needs no access code, and it only writes to the `StateChunks TEST` and `Scan Log TEST` tabs. The server allows it only while Script Property **`TEST_MODE`** is `on`. Delete that property to close it again.

## Tests

```bash
node --test tests/board-sync.test.mjs
```

Requires Node 18 or newer. No install needed.

Browser click-through tests (two devices per warehouse, real `Code.gs` against an in-memory sheet, every main button and dialog):

```bash
cd tests/e2e && npm install && npm test     # needs Python 3 + Playwright and Google Chrome
python3 tests/e2e/intake_check.py           # Order Intake portal (also needs openpyxl)
```
