import test from 'node:test';
import assert from 'node:assert/strict';
import { addresses, fromFeature, fromOverpass, fromTile, houseNumber, middle, place } from '../src/places.js';

test('towns, places and addresses read from OpenStreetMap’s tags and address files', () => {
  assert.deepEqual(middle({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]] }), [1, 1]);
  assert.equal(place({ name: 'Brimfield', place: 'town' }, [-72.2, 42.1]).kind, 'town');
  const shop = place({ name: 'Family Dollar', shop: 'variety_store', 'addr:street': 'High Street' }, [-71.8, 42.3]);
  assert.deepEqual([shop.kind, shop.class, shop.street, shop.key], ['place', 'variety_store', 'High Street', 'family dollar']);
  assert.equal(place({ name: 'Elm Street', highway: 'residential' }, [0, 0]), null, 'a road is a road');
  assert.equal(place({ name: 'Bench of Remembrance', amenity: 'bench' }, [0, 0]), null, 'not somewhere anyone is sent');
  assert.equal(place({ shop: 'bakery' }, [0, 0]), null, 'no name');

  assert.equal(houseNumber(' 16A '), '16a');
  assert.equal(houseNumber('0016'), '16');
  assert.equal(houseNumber('rear'), null);
  assert.deepEqual(addresses({ 'addr:housenumber': '16;18', 'addr:street': 'Roxbury St', 'addr:city': 'Worcester' }, [1, 2])
    .map((a) => [a.number, a.key, a.town]), [['16', 'roxbury street', 'Worcester'], ['18', 'roxbury street', 'Worcester']]);
  assert.deepEqual(addresses({ number: '20-24', street: 'MAIN ST', city: 'HOLDEN' }, [1, 2]).map((a) => a.number), ['20', '24'],
    'an OpenAddresses file, a range its two ends');
  assert.deepEqual(addresses({ 'addr:street': 'Main Street' }, [1, 2]), [], 'no number');

  const both = fromFeature({ type: 'Feature', properties: { name: 'Major Bloom', shop: 'florist', 'addr:housenumber': '76',
    'addr:street': 'Millbury Street' }, geometry: { type: 'Point', coordinates: [-71.79, 42.24] } });
  assert.equal(both.place.name, 'Major Bloom');
  assert.equal(both.addresses[0].number, '76');
  assert.equal(fromOverpass({ type: 'way', center: { lat: 42.1, lon: -72.2 }, tags: { name: 'Center School', amenity: 'school' } }).place.lat, 42.1);
  assert.equal(fromTile('place', { name: 'Burncoat', class: 'neighbourhood' }, [0, 0]).place.kind, 'town');
  assert.equal(fromTile('poi', { name: 'Target', class: 'shop', subclass: 'department_store' }, [0, 0]).place.class, 'department_store');
});
