// Fetches zmanim from Hebcal for a given date (Jerusalem)
// Query params: date=YYYY-MM-DD
// Returns: { bein_hashmashos, tzet } as ISO strings

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Missing or invalid date param (YYYY-MM-DD)" });
  }

  try {
    const url = `https://www.hebcal.com/zmanim?cfg=json&latitude=31.78&longitude=35.22&tzid=Asia%2FJerusalem&date=${date}`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ error: `Hebcal returned ${response.status}` });
    }
    const data = await response.json();
    const times = data.times || {};

    // Cache for 30 days — zmanim for a past/future date never change
    res.setHeader("Cache-Control", "s-maxage=2592000, stale-while-revalidate");
    return res.status(200).json({
      date,
      bein_hashmashos: times.beinHaShmashos_5min || times.sunset,
      tzet: times.tzeit7083deg || times.nightfall || times.tzeit,
      sunset: times.sunset,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
