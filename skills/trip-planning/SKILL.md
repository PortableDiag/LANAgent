---
name: trip-planning
description: Plan a trip or outing - travel time and route between places, what is near the destination, local time and weather - use when asked how long it takes to get somewhere, to plan a day out, find places near a hotel or venue, or what time it is at a destination.
source: lanagent
inspired_by: hermes-agent maps
---

## Procedure
1. Resolve every place first: maps.geocode({ query }). If a name matches several places, ask which one (show the top 2-3 addresses) before routing.
2. Travel: maps.route({ from, to, mode }) — mode car, bike or foot. Give distance and time up front; include turn-by-turn only when asked. For several stops, route each leg and total them.
3. Around the destination: maps.nearby({ near, what, radius }) for food, pharmacy, fuel, EV charging, parking, supermarkets, hotels, museums, parks. Mention opening hours when the map has them.
4. Time: maps.timezone({ place }) for the local time and UTC offset when the destination is in another zone; convert meeting or departure times for the operator.
5. Weather, if relevant: websearch.weather({ location }).
6. Put it together as a short plan: when to leave, how long it takes, what is near, anything to watch (time-zone change, long walk, closing times).

## Rules
- Map data is OpenStreetMap: good, not perfect. Opening hours can be stale; say "per OpenStreetMap".
- Travel times assume normal conditions — no live traffic or public-transport timetables.
- Do not guess coordinates or addresses; geocode them.
