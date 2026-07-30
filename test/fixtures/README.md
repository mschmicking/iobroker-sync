# Test fixtures

## TLS certificate — generated, not committed

`test/auth-tls.test.ts` needs a real TLS handshake, because an ioBroker instance with
authentication enabled is normally also on HTTPS with a self-signed certificate, and
`allowSelfSigned` cannot be exercised against a mock.

`test/fake-server.ts` generates `self-signed-key.pem` / `self-signed-cert.pem` here on
first use and reuses them afterwards. Both are gitignored.

**Why generated rather than committed:** a committed private key — even a worthless one
scoped to localhost — is flagged by every secret scanner, forever, and the false positive
has to be re-triaged on each new scan. Generating costs roughly 150 ms once; the cached
pair then makes every later run exactly as fast as a committed fixture would be.

Requires `openssl` on PATH. Without it the TLS suite **skips** rather than fails, so a
contributor who lacks it still gets a green run — at the cost of not covering the HTTPS
login path.

To force a fresh pair, delete the two `.pem` files and run the tests again.
