// A stand-in for RadioReference's SOAP API, answering as its NuSOAP server
// does (the shapes are from real replies: SOAP-ENC:Array of <item>, typed
// leaves, an AUTH fault for a bad sign-in). The listings are made up, around
// Holden, Massachusetts, as the bench has it. For the tests, and for trying the
// Map's Find without an account (`node test/fixtures/radioreference-fake.js`).
import { createServer } from 'node:http';
import { parseXml, decode } from '../../src/soap.js';

export const ACCOUNT = { username: 'tester', password: 'pa<ss>&word', appKey: 'TESTKEY' };

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/** A value as NuSOAP encodes it. */
function enc(name, v, type = '') {
  if (Array.isArray(v)) {
    return `<${name} xsi:type="SOAP-ENC:Array" SOAP-ENC:arrayType="tns:${type || 'item'}[${v.length}]">` +
      v.map((x) => enc('item', x, type)).join('') + `</${name}>`;
  }
  if (v && typeof v === 'object') {
    return `<${name} xsi:type="tns:${type || 'struct'}">` +
      Object.entries(v).map(([k, x]) => enc(k, x, Array.isArray(x) ? ({ cats: 'cat', subcats: 'subcat', locations: 'fccLocation', frequencies: 'fccFrequency' })[k] : '')).join('') +
      `</${name}>`;
  }
  if (typeof v === 'number') return `<${name} xsi:type="xsd:${Number.isInteger(v) ? 'int' : 'decimal'}">${v}</${name}>`;
  return `<${name} xsi:type="xsd:string">${esc(v ?? '')}</${name}>`;
}

const envelope = (inner) => '<?xml version="1.0" encoding="utf-8"?><SOAP-ENV:Envelope SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="http://api.radioreference.com/soap2">' +
  `<SOAP-ENV:Body>${inner}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;

export const replyXml = (method, value, type) =>
  envelope(`<ns1:${method}Response xmlns:ns1="http://api.radioreference.com/soap2">${enc('return', value, type)}</ns1:${method}Response>`);

// As the real one sends it: Latin-1, and HTTP 500
export const faultXml = (code, message) => '<?xml version="1.0" encoding="ISO-8859-1"?><SOAP-ENV:Envelope SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/">' +
  `<SOAP-ENV:Body><SOAP-ENV:Fault><faultcode xsi:type="xsd:string">${esc(code)}</faultcode><faultstring xsi:type="xsd:string">${esc(message)}</faultstring><faultactor xsi:type="xsd:string"></faultactor><detail xsi:type="xsd:string"></detail></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

const WORCESTER = {
  ctid: 1225, countyName: 'Worcester', stid: 25, lat: 42.35, lon: -71.9, range: 30,
  cats: [
    { cid: 1, cName: 'Holden', subcats: [
      { scid: 501, scName: 'Police', lat: 42.3526, lon: -71.8626, range: 3 },
      { scid: 502, scName: 'Fire', lat: 42.3526, lon: -71.8626, range: 3 }] },
    { cid: 2, cName: 'Paxton', subcats: [{ scid: 551, scName: 'Fire', lat: 42.3112, lon: -71.9278, range: 3 }] },
    { cid: 3, cName: 'Rutland', subcats: [
      { scid: 601, scName: 'Fire', lat: 42.3695, lon: -71.948, range: 3 },
      { scid: 602, scName: 'Police', lat: 42.3695, lon: -71.948, range: 3 }] },
    // A subcategory with no place of its own: the county's is offered instead
    { cid: 4, cName: 'Amateur Radio', subcats: [{ scid: 701, scName: 'Repeaters', lat: 0, lon: 0, range: 0 }] },
    { cid: 5, cName: 'Aviation', subcats: [{ scid: 801, scName: 'Worcester Regional Airport', lat: 42.2673, lon: -71.8757, range: 5 }] },
  ],
};

// getSubcatFreqs. The mode as a number, which getMode names: the service's own
// type allows either, and one that's a number is what getMode is for
const MODES = { 1: 'FM', 2: 'FMN', 3: 'AM', 5: 'P25' };
const SUBCAT_FREQS = {
  501: [
    { fid: 1, out: 460.3875, in: 465.3875, callsign: 'KZZ900', descr: 'Police Dispatch', alpha: 'Holden PD', tone: '127.3 PL', mode: '2', scid: 501 },
    { fid: 2, out: 453.1, in: 0, callsign: '', descr: 'Police Car-to-Car', alpha: 'Holden PD 2', tone: '127.3 PL', mode: '2', scid: 501 }],
  502: [
    { fid: 3, out: 154.31, callsign: 'KZZ901', descr: 'Fire Dispatch', alpha: 'Holden FD', tone: '100.0 PL', mode: '2', scid: 502 },
    { fid: 4, out: 154.28, callsign: '', descr: 'Fire Mutual Aid', alpha: 'Fire MA', tone: 'CSQ', mode: '2', scid: 502 }],
  551: [{ fid: 5, out: 154.31, callsign: '', descr: 'Fireground', alpha: 'Paxton FG', tone: 'CSQ', mode: '2', scid: 551 }],
  601: [
    { fid: 6, out: 154.25, callsign: 'KZZ902', descr: 'Fire Dispatch', alpha: 'Rutland FD', tone: '', mode: '2', scid: 601 },
    { fid: 7, out: 453.55, callsign: '', descr: 'Fire Talkaround', alpha: 'Rutland P25', tone: 'NAC 293', mode: '5', scid: 601 },
    { fid: 8, out: 33.94, callsign: '', descr: 'Fire (low band)', alpha: 'Rutland LB', tone: '', mode: '1', scid: 601 }],
  602: [{ fid: 9, out: 155.88, callsign: '', descr: 'Police Dispatch', alpha: 'Rutland PD', tone: '023 DPL', mode: '2', scid: 602 }],
  701: [{ fid: 10, out: 146.97, in: 146.37, callsign: 'W1BIM', descr: 'W1BIM Repeater', alpha: 'W1BIM', tone: '114.8 PL', mode: '1', scid: 701 }],
  801: [{ fid: 11, out: 120.5, callsign: '', descr: 'Tower', alpha: 'ORH Tower', tone: '', mode: '3', scid: 801 }],
};

const COUNTY_FREQS = {
  '460.3875': [{ out: 460.3875, in: 465.3875, callsign: 'KZZ900', descr: 'Police Dispatch', alpha: 'Holden PD', tone: '127.3 PL', mode: 'FMN', scid: 501, ctid: 1225 }],
  '154.31': [
    // Two towns on one frequency: the name decides which is first
    { out: 154.31, callsign: '', descr: 'Fireground', alpha: 'Paxton FG', tone: 'CSQ', mode: 'FMN', scid: 551, ctid: 1225 },
    { out: 154.31, callsign: 'KZZ901', descr: 'Fire Dispatch', alpha: 'Holden FD', tone: '100.0 PL', mode: 'FMN', scid: 502, ctid: 1225 },
  ],
  '154.25': [{ out: 154.25, callsign: 'KZZ902', descr: 'Fire Dispatch', alpha: 'Rutland FD', tone: '', mode: 'FMN', scid: 601, ctid: 1225 }],
  '146.97': [{ out: 146.97, in: 146.37, callsign: 'W1BIM', descr: 'W1BIM Repeater', alpha: 'W1BIM', tone: '114.8 PL', mode: 'FM', scid: 701, ctid: 1225 }],
  // A trunked system's: left out
  '851.0125': [{ out: 851.0125, sid: 77, ctid: 1225, descr: 'Control channel' }],
};
const STATE_FREQS = {
  '155.175': [{ out: 155.175, callsign: '', descr: 'EMS Statewide Mutual Aid', alpha: 'MA EMS', mode: 'FMN', scid: 9101, aid: 9001 }],
};
const AGENCIES = {
  9001: { aid: 9001, agencyName: 'Massachusetts EMS', lat: 42.36, lon: -71.06, range: 100,
    cats: [{ cid: 90, cName: 'Statewide', subcats: [{ scid: 9101, scName: 'Mutual Aid', lat: 0, lon: 0, range: 0 }] }] },
};
const FCC = {
  KZZ900: { licensee: 'Town of Holden', callsign: 'KZZ900', status: 'Active',
    locations: [
      { locationNumber: 1, type: 'Fixed', address: '1370 Main St', city: 'Holden', state: 'MA', lat: 42.35105, lon: -71.86312 },
      { locationNumber: 2, type: 'Fixed', address: 'Asnebumskit Hill', city: 'Paxton', state: 'MA', lat: 42.3015, lon: -71.8789 },
      { locationNumber: 3, type: 'Mobile', address: '', city: '', state: '', lat: 0, lon: 0 }],
    frequencies: [
      { locationNumber: 1, frequency: 460.3875, class: 'FB2' },
      { locationNumber: 2, frequency: 465.3875, class: 'FX1' },
      { locationNumber: 3, frequency: 465.3875, class: 'MO' }] },
  KZZ901: { licensee: 'Town of Holden', callsign: 'KZZ901', status: 'Active',
    locations: [{ locationNumber: 1, type: 'Fixed', address: '1370 Main St', city: 'Holden', state: 'MA', lat: 42.35105, lon: -71.86312 }],
    frequencies: [{ locationNumber: 1, frequency: 154.31, class: 'FB' }] },
  // Its longitude without the sign, as a source might give it: put right by the reader
  KZZ902: { licensee: 'Town of Rutland', callsign: 'KZZ902', status: 'Active',
    locations: [{ locationNumber: 1, type: 'Fixed', address: '250 Main St', city: 'Rutland', state: 'MA', lat: 42.3699, lon: 71.9468 }],
    frequencies: [{ locationNumber: 1, frequency: 154.25, class: 'FB' }] },
};

class Fault extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * The service: what a method answers, given its parameters.
 * @param {string} method - The operation.
 * @param {object} p - Its decoded parameters, authInfo among them.
 * @returns {[unknown, string?]} The value, and its item type for arrays.
 */
function answer(method, p) {
  if (method === 'getCountryList') return [[{ coid: 1, countryName: 'United States', countryCode: 'US' }], 'Country'];
  const a = p.authInfo ?? {};
  if (!a.username || !a.password) throw new Fault('AUTH', 'No username or password entered');
  if (a.appKey !== ACCOUNT.appKey) throw new Fault('AUTH', 'Invalid Application Key');
  if (a.username !== ACCOUNT.username || a.password !== ACCOUNT.password) throw new Fault('AUTH', 'Invalid Username or Password');
  const key = (f) => String(Number(f));
  switch (method) {
    case 'getUserData': return [{ username: ACCOUNT.username, subExpireDate: '03-01-2027' }, 'UserInfo'];
    case 'getZipcodeInfo':
      if (String(p.zipcode).replace(/^0+/, '') !== '1520') throw new Fault('Server', 'Invalid zipcode');
      return [{ zipCode: 1520, lat: '42.3517', lon: '-71.8631', city: 'Holden', stid: 25, ctid: 1225 }, 'ZipInfo'];
    case 'searchCountyFreq': return [p.ctid === 1225 ? COUNTY_FREQS[key(p.freq)] ?? [] : [], 'searchFreqResult'];
    case 'searchStateFreq': return [p.stid === 25 ? STATE_FREQS[key(p.freq)] ?? [] : [], 'searchFreqResult'];
    case 'getCountyInfo':
      if (p.ctid !== 1225) throw new Fault('Server', 'Invalid County ID');
      return [WORCESTER, 'CountyInfo'];
    case 'getAgencyInfo':
      if (!AGENCIES[p.aid]) throw new Fault('Server', 'Invalid Agency ID');
      return [AGENCIES[p.aid], 'AgencyInfo'];
    case 'fccGetCallsign':
      if (!FCC[p.callsign]) throw new Fault('Server', 'Callsign not found');
      return [FCC[p.callsign], 'fccCallsignDetails'];
    case 'getSubcatFreqs':
      if (!SUBCAT_FREQS[p.scid]) throw new Fault('Server', 'Invalid Subcategory ID');
      return [SUBCAT_FREQS[p.scid], 'freq'];
    case 'getMode':
      if (!MODES[p.mode]) throw new Fault('Server', 'Invalid Mode ID');
      return [[{ mode: p.mode, modeName: MODES[p.mode] }], 'mode'];
    default: throw new Fault('Client', `Operation '${method}' is not defined in the WSDL for this service`);
  }
}

/**
 * Answer one request's body.
 * @param {string} xml - The request.
 * @param {object[]} [calls] - Each call is pushed here: {method, params}.
 * @returns {{status: number, body: Buffer}} The reply.
 */
export function respond(xml, calls) {
  const op = parseXml(xml).kids[0].kids.find((k) => k.name.endsWith('Body')).kids[0];
  const method = op.name.slice(op.name.indexOf(':') + 1);
  const params = Object.fromEntries(op.kids.map((k) => [k.name, decode(k)]));
  calls?.push({ method, params });
  try {
    const [value, type] = answer(method, params);
    return { status: 200, body: Buffer.from(replyXml(method, value, type), 'utf8') };
  } catch (e) {
    if (!(e instanceof Fault)) throw e;
    return { status: 500, body: Buffer.from(faultXml(e.code, e.message), 'latin1') };
  }
}

/**
 * A fetch that goes to the stand-in instead.
 * @param {object[]} [calls] - Each call is pushed here.
 * @returns {typeof fetch} The fetch.
 */
export function fakeFetch(calls) {
  return async (url, opts) => {
    const { status, body } = respond(String(opts.body), calls);
    return new Response(body, { status, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
  };
}

/**
 * The stand-in over HTTP, for a whole AirScribe to use (radioreference.endpoint).
 * @param {number} [port] - Where; 0 for any.
 * @returns {Promise<import('node:http').Server>} Listening on 127.0.0.1.
 */
export async function serve(port = 0) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const { status, body } = respond(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(status, { 'Content-Type': 'text/xml; charset=utf-8' }).end(body);
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('radioreference-fake.js')) {
  const server = await serve(Number(process.argv[2] ?? 8101));
  console.log(`stand-in RadioReference on http://127.0.0.1:${server.address().port}/soap2/index.php`);
}
