// Basic geo helpers (CommonJS)

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Haversine distance in kilometers
function haversineKm(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371; // km
  const dLat = toRad((b.lat ?? 0) - (a.lat ?? 0));
  const dLon = toRad((b.lon ?? 0) - (a.lon ?? 0));
  const lat1 = toRad(a.lat ?? 0);
  const lat2 = toRad(b.lat ?? 0);

  const sinDlat = Math.sin(dLat / 2);
  const sinDlon = Math.sin(dLon / 2);

  const aa = sinDlat * sinDlat + Math.cos(lat1) * Math.cos(lat2) * sinDlon * sinDlon;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return R * c;
}

module.exports = { haversineKm };