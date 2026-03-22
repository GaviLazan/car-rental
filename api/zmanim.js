// Fetches zmanim from Hebcal for a given date (Jerusalem)
// Query params: date=YYYY-MM-DD
// Returns: { candles, havdalah } as ISO strings

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res
      .status(400)
      .json({ error: "Missing or invalid date param (YYYY-MM-DD)" });
  }

  try {
    // Use the Shabbat API with Jerusalem's GeoNames ID (281184)
    // M=on includes Havdalah, dt= sets the Friday date
    const url = `https://www.hebcal.com/shabbat?cfg=json&geonameid=281184&M=on&dt=${date}`;
    const response = await fetch(url);
    if (!response.ok) {
      return res
        .status(502)
        .json({ error: `Hebcal returned ${response.status}` });
    }
    const data = await response.json();

    // Extract candles and havdalah from items array
    const candles = data.items?.find((i) => i.category === "candles");
    const havdalah = data.items?.find((i) => i.category === "havdalah");

    if (!candles || !havdalah) {
      return res
        .status(404)
        .json({ error: "Could not find candle/havdalah times in response" });
    }

    res.setHeader("Cache-Control", "s-maxage=2592000, stale-while-revalidate");
    return res.status(200).json({
      date,
      bein_hashmashos: candles.date, // ISO datetime — candle lighting IS bein hashmoshos
      tzet: havdalah.date, // ISO datetime — havdalah
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
