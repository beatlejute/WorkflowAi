// Самоподписанный сертификат для локального TLS-сервера тестов (путь клиента
// модели через прокси). Создаётся при запуске средствами node:crypto: ключ в
// репозиторий не кладётся, openssl не нужен. Ключ EC P-256, подпись
// ecdsa-with-SHA256, CN и subjectAltName — localhost и 127.0.0.1, срок — сутки
// в обе стороны от текущего момента.
import crypto from 'node:crypto';

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const seq = (...parts) => der(0x30, Buffer.concat(parts));
const set = (...parts) => der(0x31, Buffer.concat(parts));
const explicit = (n, content) => der(0xa0 + n, content);
const octets = (content) => der(0x04, content);
const bitString = (content) => der(0x03, Buffer.concat([Buffer.from([0]), content]));
const utf8 = (text) => der(0x0c, Buffer.from(text, 'utf-8'));
const bool = (value) => der(0x01, Buffer.from([value ? 0xff : 0]));

function integer(bytes) {
  const body = bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return der(0x02, body);
}

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let n = arc >> 7; n > 0; n >>= 7) chunk.unshift(0x80 | (n & 0x7f));
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}

function utcTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(text, 'ascii'));
}

function pem(label, body) {
  const lines = body.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

/** { key, cert } в PEM для `https.createServer`; `cert` же — доверенный `ca` клиента. */
export function makeSelfSignedCert(commonName = 'localhost') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signatureAlgorithm = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(set(seq(oid('2.5.4.3'), utf8(commonName))));
  const now = Date.now();
  const subjectAltName = seq(
    der(0x82, Buffer.from(commonName, 'ascii')), // dNSName
    der(0x87, Buffer.from([127, 0, 0, 1])),      // iPAddress
  );
  const extensions = explicit(3, seq(
    seq(oid('2.5.29.19'), bool(true), octets(seq(bool(true)))), // basicConstraints: CA
    seq(oid('2.5.29.17'), octets(subjectAltName)),
  ));
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(crypto.randomBytes(8)),
    signatureAlgorithm,
    name,
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certificate = seq(tbs, signatureAlgorithm, bitString(signature));
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pem('CERTIFICATE', certificate),
  };
}
