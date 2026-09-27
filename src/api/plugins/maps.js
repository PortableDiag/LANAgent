import { BasePlugin } from '../core/basePlugin.js';
import { extractParams } from '../../services/webtools/extractParams.js';
import { geocode, reverse, route, timezone, nearby, resolvePoint, haversine } from '../../services/webtools/osm.js';

/**
 * Maps from OpenStreetMap, no key needed: find a place, name a coordinate, directions and
 * travel time, what's nearby, distance between two places, and a place's time zone.
 */
export default class MapsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'maps';
    this.version = '1.0.0';
    this.description = 'OpenStreetMap maps: geocode places, directions and travel time, nearby places, distances and time zones';
    this.commands = [
      { command: 'geocode', description: 'Find a place or address and give its coordinates',
        usage: 'geocode({ query: "Eiffel Tower" })', examples: ['where is the eiffel tower', 'get the coordinates of 10 downing street', 'find this address on the map'] },
      { command: 'reverse', description: 'Say what address or place is at a latitude/longitude',
        usage: 'reverse({ lat: 48.8584, lon: 2.2945 })', examples: ['what is at 48.8584, 2.2945', 'which address are these coordinates'] },
      { command: 'route', description: 'Directions, distance and travel time between two places by car, bike or on foot',
        usage: 'route({ from: "Louvre, Paris", to: "Eiffel Tower", mode: "car" })  // mode: car | bike | foot',
        examples: ['how long to drive from the louvre to the eiffel tower', 'directions from here to the station on foot', 'how far is it to cycle from A to B'] },
      { command: 'nearby', description: 'Find places of a kind near somewhere (cafes, pharmacies, fuel, EV charging, supermarkets, parks…)',
        usage: 'nearby({ near: "Times Square", what: "pharmacy", radius: 1000 })',
        examples: ['find a pharmacy near times square', 'coffee shops near the office', 'nearest ev charging station to this address'] },
      { command: 'distance', description: 'Straight-line distance between two places',
        usage: 'distance({ from: "London", to: "Paris" })', examples: ['how far is london from paris as the crow flies', 'distance between these two cities'] },
      { command: 'timezone', description: 'What time it is right now in a city, country or place: current local time, date and time zone',
        usage: 'timezone({ place: "Tokyo" })  // or lat/lon', examples: ['what time is it in tokyo right now', 'what time is it in London', 'what\'s the time in Paris', 'current time in Sydney', 'what time zone is denver in', 'local time at these coordinates'] }
    ];
  }

  async execute(params = {}) {
    const { action, ...p } = await extractParams(this, params.action, params);
    try {
      switch (action) {
        case 'geocode': {
          const places = await geocode(p.query || p.place || p.address || p.location, { limit: p.limit });
          return { success: true, places, result: places.length ? places.map(x => `${x.address} — ${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}`).join('\n') : 'No match on the map.' };
        }
        case 'reverse': {
          const r = await reverse(p.lat ?? p.latitude, p.lon ?? p.lng ?? p.longitude);
          return { success: true, place: r, result: r.address };
        }
        case 'route': {
          const r = await route(p.from || p.origin || p.start, p.to || p.destination || p.end, { mode: p.mode || p.profile });
          const h = Math.floor(r.durationMin / 60), m = r.durationMin % 60;
          const time = h ? `${h} h ${m} min` : `${m} min`;
          return { success: true, ...r, result: `${r.mode === 'car' ? 'Driving' : r.mode === 'bike' ? 'Cycling' : 'Walking'}: ${r.distanceKm} km, about ${time}\nFrom: ${r.from.name}\nTo: ${r.to.name}${r.directions.length ? `\n\n${r.directions.map((d, i) => `${i + 1}. ${d}`).join('\n')}` : ''}` };
        }
        case 'nearby': {
          const r = await nearby(p.near || p.location || p.place, p.what || p.category || p.type || p.query, { radius: p.radius, limit: p.limit });
          return { success: true, ...r, result: r.places.length ? r.places.map(x => `• ${x.name} — ${x.distanceM} m${x.address ? `, ${x.address}` : ''}${x.openingHours ? ` (${x.openingHours})` : ''}`).join('\n') : `Nothing tagged ${r.category} within ${r.radiusM} m.` };
        }
        case 'distance': {
          const [a, b] = [await resolvePoint(p.from), await resolvePoint(p.to)];
          const km = haversine(a.lat, a.lon, b.lat, b.lon) / 1000;
          return { success: true, from: a, to: b, km: +km.toFixed(2), miles: +(km * 0.621371).toFixed(2), result: `${km.toFixed(1)} km (${(km * 0.621371).toFixed(1)} mi) in a straight line` };
        }
        case 'timezone': {
          const pt = p.lat != null ? await resolvePoint({ lat: p.lat, lon: p.lon ?? p.lng }) : await resolvePoint(p.place || p.location || p.query);
          const r = await timezone(pt.lat, pt.lon);
          return { success: true, place: pt.name, ...r, result: `${pt.name}: ${r.timezone} (${r.utcOffset}) — ${r.localTime}` };
        }
        default:
          return { success: false, error: `Unknown action '${action}'. Use: geocode, reverse, route, nearby, distance, timezone` };
      }
    } catch (error) {
      this.logger.warn(`maps ${action} failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
