import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Throwaway certificates for the TLS tests, made with the `openssl` command line in a temp directory and removed
 * straight away. Nothing is committed: no key in this repo ever protects anything.
 */

export interface Credentials {
  key: string;
  cert: string;
}

export interface Fixtures {
  /** A CA the test process trusts. */
  ca: string;
  /** Signed by `ca`, valid for `img.example`. */
  good: Credentials;
  /** Signed by `ca`, but valid only for `other.example`. */
  wrongName: Credentials;
  /** Signed by itself, claims `img.example`, trusted by nobody. */
  selfSigned: Credentials;
  /** Signed by a CA nobody trusts, claims `img.example`. */
  unknownCa: Credentials;
}

const EC = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];

export function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeCa(dir: string, name: string): string {
  const key = path.join(dir, `${name}.key`);
  const cert = path.join(dir, `${name}.pem`);
  const subject = ['-subj', `/CN=Aplos test ${name}`, '-days', '2'];
  const ca = ['-addext', 'basicConstraints=critical,CA:TRUE'];
  execFileSync(
    'openssl',
    ['req', '-x509', ...EC, '-keyout', key, '-out', cert, ...subject, ...ca],
    {
      stdio: 'ignore',
    },
  );
  return name;
}

function issue(dir: string, issuer: string, name: string, dnsName: string): Credentials {
  const key = path.join(dir, `${name}.key`);
  const csr = path.join(dir, `${name}.csr`);
  const cert = path.join(dir, `${name}.pem`);
  const ext = path.join(dir, `${name}.ext`);
  writeFileSync(ext, `subjectAltName=DNS:${dnsName}\nbasicConstraints=CA:FALSE\n`);
  const request = ['req', '-new', ...EC, '-keyout', key, '-out', csr, '-subj', `/CN=${dnsName}`];
  execFileSync('openssl', request, { stdio: 'ignore' });
  const sign = ['x509', '-req', '-in', csr, '-CA', path.join(dir, `${issuer}.pem`)];
  const rest = ['-CAkey', path.join(dir, `${issuer}.key`), '-CAcreateserial', '-days', '2'];
  execFileSync('openssl', [...sign, ...rest, '-extfile', ext, '-out', cert], { stdio: 'ignore' });
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
}

function selfSigned(dir: string): Credentials {
  const key = path.join(dir, 'self.key');
  const cert = path.join(dir, 'self.pem');
  const args = ['req', '-x509', ...EC, '-keyout', key, '-out', cert, '-subj', '/CN=img.example'];
  execFileSync('openssl', [...args, '-days', '2', '-addext', 'subjectAltName=DNS:img.example'], {
    stdio: 'ignore',
  });
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
}

export function makeFixtures(): Fixtures {
  const dir = mkdtempSync(path.join(tmpdir(), 'aplos-tls-'));
  try {
    makeCa(dir, 'ca');
    makeCa(dir, 'rogue');
    return {
      ca: readFileSync(path.join(dir, 'ca.pem'), 'utf8'),
      good: issue(dir, 'ca', 'good', 'img.example'),
      wrongName: issue(dir, 'ca', 'wrong', 'other.example'),
      selfSigned: selfSigned(dir),
      unknownCa: issue(dir, 'rogue', 'unknown', 'img.example'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
