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
- **Layout:** it follows the warehouse plan along the north wall, west to east.
  - **Loading docks:** the **9 loading docks** (D1–D9), each showing the order being loaded, its carrier, pallet count and the lanes it's staged in.
  - **Staging area:** the **12 staging lanes** (S51–S62) in the staging area, with every pallet in its floor spot, 2x stacks, and dwell alerts (⚠ aging, ⏱ overdue, ⛔ over a week).
  - **Racking:** shown behind the lanes.
- **Top and bottom:** KPIs across the top; orders on the floor, dwell alerts and today's totals along the bottom.
- **Updates:** it refreshes every 10 seconds and warns if the connection drops.
- **Read-only:** it never changes the board.
- **Sign in:** enter the access code once on the TV. The code picks the warehouse.
- **Screen size:** it's designed for 1920×1080 and scales to fit any screen.

To change which docks or lanes are shown, or their order, edit `FLOOR_LAYOUT` near the top of `dashboard.html`.

## Adding a shipment

No SLP barcodes are needed. A shipment is an order number plus a number of pallets.
- **Quick bar:** scan or type the order number and press Enter. The cursor jumps to **Pallets**; type the count and press Enter.
- **Scan Order:** the same with the camera. Scanning the order barcode fills in the order number, then you enter the number of pallets. Carrier and destination can be added here.
- **Pallet labels:** each pallet gets a label from the order number, e.g. `SO-41200-01`, `SO-41200-02`. Numbering carries on when more pallets are added to the same order later.
- **Lane:** the lane box picks a lane automatically (same order first, then an empty lane), or choose one yourself.
- **Edit order:** use **Add pallets** to add more to an existing order.

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
```
