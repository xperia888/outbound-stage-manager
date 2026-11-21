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
| `Index.html` | The full app (HTML, Tailwind CSS, JavaScript) |
| `Code.gs` | Apps Script backend: serves the page and stores board state in the `StateChunks` sheet |

## Running modes

- **Local Mode** (opening `Index.html` directly, or from GitHub Pages): the board is saved in that browser only. Each device keeps its own separate board.
- **Cloud Sync** (served from Google Apps Script): all devices share one board stored in a Google Sheet.

## Deploying with Google Apps Script

1. Create or open a Google Sheet, then go to **Extensions → Apps Script**.
2. Replace `Code.gs` with this repo's `Code.gs`.
3. Add an HTML file named **`Index`** and paste in `Index.html`.
4. **Deploy → New deployment → Web app**. Choose who can access it, then open the web-app URL.

Board state is saved to the `StateChunks` tab, split across rows to stay under the 50,000-character cell limit. Data from the old single-cell `State!A1` layout is read once if `StateChunks` is empty.

## Known issues

- Background sync stops pulling updates on a device after that device's first edit, because the save debounce timer is never reset.
- Saves are last-write-wins for the whole board, so simultaneous scans on two devices can overwrite each other.
- Carrier or order names containing an apostrophe break some inline buttons.
