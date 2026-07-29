# Test fixtures

## `self-signed-cert.pem` / `self-signed-key.pem`

A throwaway self-signed certificate for `localhost` / `127.0.0.1`, valid until 2046,
used by `test/auth-tls.test.ts` to start the fake Admin server over HTTPS.

**This key is deliberately committed and has no security value.** It protects nothing,
is generated for this repository only, and is never used outside an in-process test
server bound to a random loopback port.

It exists because an ioBroker instance with authentication enabled is normally also on
HTTPS with a self-signed certificate — Admin will not take a password over plain HTTP.
Testing the `allowSelfSigned` path therefore needs a real TLS handshake, not a mock.

Regenerate with:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 7300 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout self-signed-key.pem -out self-signed-cert.pem
```

> **Before making this repository public:** GitHub secret scanning flags committed
> private keys, even harmless ones. Either accept the alert and dismiss it as a test
> fixture, or switch to generating the pair at test-setup time (CI runners have
> `openssl`).
