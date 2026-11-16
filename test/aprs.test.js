import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame } from '../src/ax25.js';
import { decodeBss, decodePacket, parseAprs, symbolOf } from '../src/aprs.js';

/** An AX.25 UI frame as a radio's modem hands one over, as the sidecar's simulator builds them. */
function frame(source, destination, path, info, { control = 0x03, pid = 0xf0 } = {}) {
  const calls = [destination, source, ...path];
  const parts = calls.map((c, i) => {
    const [base, ssid = '0'] = c.replace('*', '').split('-');
    const a = Buffer.alloc(7);
    for (let k = 0; k < 6; k++) a[k] = (base.padEnd(6).charCodeAt(k)) << 1;
    a[6] = 0x60 | ((Number(ssid) & 0x0f) << 1) | (c.endsWith('*') ? 0x80 : 0) | (i === calls.length - 1 ? 1 : 0);
    return a;
  });
  return Buffer.concat([...parts, Buffer.from([control, pid]), Buffer.from(info, 'latin1')]);
}

const near = (a, b, places, what) => assert.equal(Number(a).toFixed(places), Number(b).toFixed(places), what);

test('an AX.25 frame: addresses, the digipeater that repeated it, the information field', () => {
  const f = decodeFrame(frame('N1HLD-9', 'APRS', ['N1RUT*', 'WIDE2-1'], '!hello'));
  assert.deepEqual([f.source, f.destination, f.path, f.pid, f.info.toString()],
    ['N1HLD-9', 'APRS', ['N1RUT*', 'WIDE2-1'], 0xf0, '!hello']);
  assert.equal(decodeFrame(frame('N1HLD', 'APRS', [], '!x', { control: 0x00 })), null, 'a connected-mode frame isn\'t a packet');
  assert.equal(decodeFrame(Buffer.from('not a frame at all')), null);
  assert.equal(decodeFrame(frame('N1HLD', 'APRS', [], '').subarray(0, 10)), null, 'cut short');
  const bad = frame('N1HLD', 'APRS', [], '!x');
  bad[2] |= 1;
  assert.equal(decodeFrame(bad), null, 'an address that ends too soon');
});

// The positions below are Ham::APRS::FAP's test packets (t/20 to 41), with FAP's answers
test('plain positions: hemispheres, ambiguity, timestamps, extensions and the comment', () => {
  let p = parseAprs('!6028.51N/02505.68E#PHG7220/RELAY,WIDE, OH2AP Jarvenpaa');
  near(p.lat, 60.4752, 4); near(p.lon, 25.0947, 4);
  assert.deepEqual([p.type, p.symbolTable, p.symbolCode, p.phg, p.comment], ['position', '/', '#', '7220', 'RELAY,WIDE, OH2AP Jarvenpaa']);
  p = parseAprs('!6028.51S/02505.68W#PHG7220RELAY,WIDE, OH2AP Jarvenpaa');
  near(p.lat, -60.4752, 4); near(p.lon, -25.0947, 4);
  p = parseAprs('!602 .  S/0250 .  W#PHG7220RELAY,WIDE, OH2AP Jarvenpaa');
  near(p.lat, -60.4167, 4); near(p.lon, -25.0833, 4);
  assert.equal(p.ambiguity, 3, 'the middle of a ten-minute box');
  p = parseAprs('!60  .  S/025  .  W#PHG7220RELAY,WIDE, OH2AP Jarvenpaa');
  near(p.lat, -60.5, 4); near(p.lon, -25.5, 4);
  p = parseAprs('hoponassualku!6028.51S/02505.68W#PHG7220RELAY,WIDE, OH2AP Jarvenpaa');
  near(p.lat, -60.4752, 4);
  assert.equal(p.comment, 'RELAY,WIDE, OH2AP Jarvenpaa', 'a position behind other text, as old trackers send');
  assert.equal(parseAprs('!6028.51N/02505.68E#PHG7220   RELAY,WIDE, OH2AP Jarvenpaa  \t ').comment, 'RELAY,WIDE, OH2AP Jarvenpaa');
  p = parseAprs('/180000z0609.31S/10642.85E>058/010/A=000079 13.8V 15CYB1RUS-9 Mobile Tracker');
  near(p.lat, -6.15517, 5); near(p.lon, 106.71417, 5); near(p.altitude, 24.0792, 4);
  assert.deepEqual([p.course, p.timestamp, p.comment], [58, '180000z', '13.8V 15CYB1RUS-9 Mobile Tracker']);
  near(p.speed, 18.52, 2);
  near(parseAprs('/180000z0609.31S/10642.85E>058/010/A=-00079 13.8V').altitude, -24.0792, 4);
  p = parseAprs('=0606.23S/10644.61E-GW SAHARA PENJARINGAN JAKARTA 147.880 MHz');
  near(p.lat, -6.10383, 5); near(p.lon, 106.7435, 4);
  assert.equal(p.messaging, true);
  p = parseAprs('!6253.52N/02739.47E>036/010/A=000465 |!!!!!!!!!!!!!!|');
  near(p.lat, 62.892, 4); near(p.lon, 27.6578, 4); near(p.speed, 18.52, 2); near(p.altitude, 141.732, 3);
  assert.equal(p.course, 36);
  assert.equal(p.comment, undefined, 'the extensions and comment telemetry taken out');
});

test('compressed positions', () => {
  let p = parseAprs('!I0-X;T_Wv&{-Aigate testing');
  near(p.lat, 60.052, 4); near(p.lon, 24.5045, 4);
  assert.deepEqual([p.symbolTable, p.symbolCode, p.speed, p.course, p.comment], ['I', '&', undefined, undefined, 'igate testing']);
  p = parseAprs('!//zPHTfVv>!V_ Tero, Green Volvo 960, GGL-880|!!!!!!!!!!!!!!|');
  near(p.lat, 60.3582, 4); near(p.lon, 24.8084, 4); near(p.speed, 107.57, 2);
  assert.deepEqual([p.course, p.comment], [360, 'Tero, Green Volvo 960, GGL-880']);
  assert.equal(parseAprs('@075111h/@@.Y:*lol ').type, 'invalid', 'too short to be one');
});

test('weather: with a position, compressed, and the readings in metric', () => {
  let p = parseAprs('=6030.35N/02443.91E_150/002g004t039r001P002p004h00b10125XRSW');
  near(p.lat, 60.5058, 4); near(p.lon, 24.7318, 4);
  assert.equal(p.type, 'weather');
  assert.deepEqual(p.wx, { windDirection: 150, windSpeed: 0.9, windGust: 1.8, temp: 3.9, rain1h: 0.3, rainMidnight: 0.5,
    rain24h: 1, humidity: 100, pressure: 1012.5 });
  assert.equal(p.comment, 'XRSW');
  p = parseAprs('@011241z3558.58N/13629.67E_068/001g001t033r000p020P020b09860h98Oregon WMR100N Weather Station {UIV32N}');
  near(p.lat, 35.9763, 4); near(p.lon, 136.4945, 4);
  assert.deepEqual([p.wx.windDirection, p.wx.windSpeed, p.wx.windGust, p.wx.temp, p.wx.humidity, p.wx.pressure, p.wx.rain1h],
    [68, 0.4, 0.4, 0.6, 98, 986, 0]);
  assert.equal(p.comment, 'Oregon WMR100N Weather Station {UIV32N}');
  p = parseAprs('@011444z/:JF!T/W-_e!bg001t054r000p010P010h65b10073WS 2300 {UIV32N}');
  assert.deepEqual([p.symbolTable, p.symbolCode, p.comment], ['/', '_', 'WS 2300 {UIV32N}']);
  assert.deepEqual([p.wx.windGust, p.wx.temp, p.wx.humidity, p.wx.pressure, p.wx.windDirection], [0.4, 12.2, 65, 1007.3, 272]);
  p = parseAprs('_10090556c220s004g005t077r000p000P000h50b09900wRSW');
  assert.deepEqual([p.type, p.wx.windDirection, p.wx.windSpeed, p.wx.temp, p.wx.humidity], ['weather', 220, 1.8, 25, 50]);
  assert.equal(parseAprs('=3851.38N/09908.75W_Home of KA0RID').comment, 'Home of KA0RID', 'a weather symbol with no weather');
});

test('Mic-E: the position half in the destination, speed, course, altitude and status', () => {
  let p = parseAprs('\'I\',l \x1C>/]', { destination: 'SX15S6' });
  near(p.lat, -38.256, 4); near(p.lon, 145.186, 4);
  assert.deepEqual([p.format, p.speed, p.course, p.symbolTable, p.symbolCode, p.comment, p.device],
    ['mic-e', 0, 0, '/', '>', undefined, 'Kenwood TM-D700'], 'FAP leaves "]" as the comment: it is the radio');
  p = parseAprs('`c51!f?>/]"3x}=', { destination: 'TQ4W2V' });
  near(p.lat, 41.7877, 4); near(p.lon, -71.4202, 4); near(p.speed, 105.56, 2);
  assert.deepEqual([p.course, p.altitude, p.comment, p.device, p.micE], [35, 6, undefined, 'Kenwood TM-D710', 'En route']);
  p = parseAprs('`c51!f?>/`Heading home_%', { destination: 'TQ4W2V' });
  assert.deepEqual([p.comment, p.device], ['Heading home', 'Yaesu FTM-400']);
  assert.equal(parseAprs('`\'O<l!{,,"4R}', { destination: '5U2V08' }).type, 'invalid', 'not a symbol table');
});

test('objects, items, messages, status, telemetry, third party and NMEA', () => {
  const sral = Buffer.from('3B5352414C20485120202A3130303932377A533025452F5468345F612020414B617570696E6D61656E706F6C6B75392C6F70656E204D2D546831322D31372C4631322D3134206C636C', 'hex').toString('latin1');
  let p = parseAprs(sral);
  near(p.lat, 60.2305, 4); near(p.lon, 24.879, 4);
  assert.deepEqual([p.type, p.name, p.alive, p.symbolTable, p.symbolCode, p.comment],
    ['object', 'SRAL HQ', true, 'S', 'a', 'Kaupinmaenpolku9,open M-Th12-17,F12-14 lcl']);
  p = parseAprs(';LEADER   *092345z4903.50N/07201.75W>088/036');
  near(p.lat, 49.0583, 4); near(p.lon, -72.0292, 4);
  assert.deepEqual([p.name, p.course, p.comment], ['LEADER', 88, undefined]);
  assert.equal(parseAprs(';LEADER   _092345z4903.50N/07201.75W>088/036').alive, false, 'killed');
  p = parseAprs(')AID #2!4903.50N/07201.75WA');
  assert.deepEqual([p.type, p.name, p.alive, p.symbolCode], ['item', 'AID #2', true, 'A']);

  assert.deepEqual(parseAprs(':OH7LZB   :Testing, 1 2 3{42'),
    { type: 'message', addressee: 'OH7LZB', messageId: '42', message: 'Testing, 1 2 3' });
  assert.deepEqual(parseAprs(':OH7LZB   :Testing, 1 2 3{F00b4}'),
    { type: 'message', addressee: 'OH7LZB', messageId: 'F00b4', replyAck: '', message: 'Testing, 1 2 3' });
  assert.equal(parseAprs(':OH7LZB   :ack1Ff84').ack, '1Ff84');
  assert.equal(parseAprs(':OH7LZB   :rej42').rej, '42');
  assert.equal(parseAprs(':BLN1     :Net tonight').bulletin, true);

  assert.deepEqual(parseAprs('>092345zNet in progress'), { type: 'status', status: 'Net in progress', timestamp: '092345z' });
  assert.equal(parseAprs('>Monitoring 146.52').status, 'Monitoring 146.52');
  assert.equal(parseAprs('T#005,199,000,255,073,123,01101001').telemetry, '005,199,000,255,073,123,01101001');
  p = parseAprs('}W1AW>APRS,TCPIP,N1RUT*:!4221.06N/07151.78W>');
  assert.deepEqual([p.type, p.thirdParty.source], ['position', 'W1AW']);
  p = parseAprs('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A');
  near(p.lat, 48.1173, 4); near(p.lon, 11.5167, 4); near(p.speed, 41.48, 2);
  assert.equal(p.course, 84);
  assert.equal(parseAprs('<IGATE,MSG_CNT=0').type, 'other');
});

test('the radios\' BSS packets, from HTCommander\'s protocol notes', () => {
  // From KK7VZT, to nobody, "hello", and a location that reads as near Portland, Oregon
  let p = decodeBss(Buffer.from('0107204B4B37565A540121062468656C6C6F072514C72DC7CDF1', 'hex'));
  assert.deepEqual([p.source, p.destination, p.message], ['KK7VZT', undefined, 'hello']);
  near(p.lat, 45.3903, 4); near(p.lon, -122.761, 3);
  p = decodeBss(Buffer.from('0107204B4B37565A540D2514C72DC7CDF1002A00000151', 'hex'));
  assert.deepEqual([p.altitude, p.heading], [42, 337], 'altitude and heading after the location');
  p = decodeBss(Buffer.from('0107204B4B37565A548500050927' + Buffer.from('KK7VZT-7').toString('hex'), 'hex'));
  assert.deepEqual([p.counter, p.locationRequest], [5, 'KK7VZT-7']);
  assert.equal(decodeBss(Buffer.from('0109', 'hex')), null, 'cut short, and from nobody');
});

test('a whole packet: decoded, with what it is and one line saying what it said', () => {
  let p = decodePacket(frame('N1HLD-9', 'APRS', ['WIDE1-1'], '!4221.06N/07151.78W>090/035 Mobile in Holden'));
  assert.deepEqual([p.format, p.source, p.destination, p.path, p.type, p.symbol.name, p.symbol.icon],
    ['aprs', 'N1HLD-9', 'APRS', ['WIDE1-1'], 'position', 'Car', '🚗']);
  assert.equal(p.summary, 'Car at 42.3510, -71.8630, 40 mph heading 90° “Mobile in Holden”');
  assert.equal(p.tnc2, 'N1HLD-9>APRS,WIDE1-1:!4221.06N/07151.78W>090/035 Mobile in Holden');
  p = decodePacket(frame('N1HLD-9', 'APRS', [], ':W1BIM    :Net at 8pm, café after{12'));
  assert.equal(p.summary, 'To W1BIM: Net at 8pm, café after', 'UTF-8 read as UTF-8');
  p = decodePacket(frame('KC1WX-13', 'APRS', [], '@151200z4220.50N/07150.10W_180/004g009t045r000p012P008h82b10132 Holden WX'));
  assert.equal(p.summary, 'Weather: 45°F, wind 180° 4 mph, gusting 9, humidity 82%, 1013.2 hPa at 42.3417, -71.8350');
  p = decodePacket(Buffer.from('0107204B4B37565A540121062468656C6C6F072514C72DC7CDF1', 'hex'));
  assert.deepEqual([p.format, p.source, p.summary], ['bss', 'KK7VZT', '“hello” at 45.3903, -122.7610']);
  assert.equal(decodePacket(Buffer.from('garbage that is no packet')), null);
  assert.deepEqual(symbolOf('\\', '#'), { name: 'Digipeater', icon: '📡', overlay: null });
  assert.equal(symbolOf('S', 'a').overlay, 'S');
});
