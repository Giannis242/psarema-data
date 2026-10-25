# psarema-data

Daily ocean data for the Psarema fishing app (Cyprus). Three times a day, `build.mjs` (GitHub Actions, `.github/workflows/ocean.yml`) cuts the
Mediterranean model's temperature at 13 depths (1 to 200 m) and mixed-layer depth around Cyprus, for 2 days back to 7 ahead, out of the public
Copernicus Marine ARCO stores (no account needed), and publishes it as `ocean.json` on GitHub Pages:
https://giannis242.github.io/psarema-data/ocean.json

Generated using E.U. Copernicus Marine Service Information (MEDSEA_ANALYSISFORECAST_PHY_006_013).
