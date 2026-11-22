# outbound-stage-manager

Outbound pallet management app: ONUS-ONT Outbound Pallet Staging Manager (v2). A single-page web app for managing outbound pallet (SLP) staging lanes on the warehouse floor, with an optional Google Sheets backend for multi-device sync.

## Features

- Staging board for lanes S51–S62 (configurable), with floor-spot capacity and 2-high double-stack support (2 stacked pallets = 1 floor spot)
- Quick scan, multi-SLP batch entry and camera QR/barcode scanning
- Drag and drop SLPs or whole orders between lanes
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

## One board on every link

Both links show the same board, stored in one Google Sheet:

- **GitHub Pages** (`https://xperia888.github.io/outbound-stage-manager/`): talks to the sheet through the Apps Script web-app URL set in `CLOUD_API_URL` in `index.html`. Phone camera scanning works here.
- **Apps Script web-app link** (ends in `/exec`): talks to the sheet directly.

Every device asks for the **access code** once, then remembers it. Without `CLOUD_API_URL`, or when opening the file directly, the app runs in **Local Mode**, where the board is saved in that browser only.

## Setup

1. Create or open a Google Sheet, then go to **Extensions → Apps Script**.
2. Replace `Code.gs` with this repo's `Code.gs`.
3. Add an HTML file named **`Index`** and paste in `index.html`.
4. Set the access code: **Project Settings (gear) → Script Properties → Add script property**, with Property `ACCESS_CODE` and a Value of your choice. Share it only with staff.
5. **Deploy → New deployment → Web app**, with **Execute as: Me** and **Who has access: Anyone**. The access code is what keeps outsiders out. Approve the permissions Google asks for. To update later, use **Manage deployments → Edit → Version: New version**, which keeps the same URL.
6. Copy the web-app URL (ends in `/exec`), paste it into `const CLOUD_API_URL = '...';` in `index.html`, and commit. GitHub Pages republishes within a minute or two.

Board state is saved to the `StateChunks` tab, split across rows to stay under the 50,000-character cell limit. Data from the old single-cell `State!A1` layout is read once if `StateChunks` is empty.

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

## Tests

```bash
node --test tests/board-sync.test.mjs
```

Requires Node 18 or newer. No install needed.
