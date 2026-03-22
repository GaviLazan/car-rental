# Car Rental Calculator

Compares CityCar, MyCar, and Shlomo Share pricing with automatic Shabbat/Yom Tov exclusion.

## Features
- Live CityCar prices via `/api/citycar` proxy (adds required headers)
- Exact Jerusalem zmanim via Hebcal API (`/api/zmanim`)
- Filters by car size, company, hide electric
- Hourly / daily / weekly / monthly comparison
- "Best overall" and "Cheapest /km" badges

## Local dev

```bash
npm install
npm run dev
```

The Vite dev server proxies `/api/*` to port 3000. To run the API routes locally, use the Vercel CLI:

```bash
npm i -g vercel
vercel dev
```

This starts both the Vite frontend and the serverless functions together on one port.

## Deploy to Vercel

```bash
vercel
```

Or connect your GitHub repo in the Vercel dashboard — it will auto-detect the Vite project and deploy on every push.

## Project structure

```
/
├── api/
│   ├── citycar.js      # Proxies CityCar prices API (adds auth headers)
│   └── zmanim.js       # Proxies Hebcal zmanim API for exact Shabbat times
├── src/
│   ├── main.jsx        # React entry point
│   └── App.jsx         # Main app component
├── index.html
├── vite.config.js
├── vercel.json
└── package.json
```

## Updating prices

- **CityCar**: Live via API — updates automatically
- **MyCar**: Hardcoded in `src/App.jsx` in `MC_CATS`. Check mycar-israel.com/price periodically
- **Shlomo Share**: Hardcoded in `src/App.jsx` in `SS_CATS`. Check their app periodically

## Notes

- Shabbat excludes ~18min before sunset → ~50min after next day sunset (per Hebcal)
- Chol HaMoed is treated as regular days
- CityCar and MyCar don't charge for Shabbat/Yom Tov; Shlomo Share does
- At least one company must remain selected
