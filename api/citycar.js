export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  try {
    const response = await fetch("https://proxy1.citycar.co.il/api/prices", {
      headers: {
        "accept": "*/*",
        "app-version": "0.1.250",
        "content-type": "application/json",
        "devicet": "WEB",
        "origin": "https://www.citycar.co.il",
        "referer": "https://www.citycar.co.il/",
        "x-requested-with": "com.citycar.flutter",
        "access-token": "",
        "access-token-type": "",
      },
    });

    if (!response.ok) {
      return res.status(502).json({ error: `CityCar returned ${response.status}` });
    }

    const data = await response.json();
    // Cache for 6 hours on CDN edge
    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
