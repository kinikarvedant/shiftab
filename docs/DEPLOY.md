# Deploying p0rtal

One p0rtal server = one venue. Devices work offline and sync to the server whenever they
can reach it. The server can live in the cloud (a small VPS is plenty) or on a machine in
the venue.

## Requirements

- **Node.js ≥ 22.18** (uses built-in TypeScript stripping and `node:sqlite`; no native modules).
- **HTTPS is mandatory.** Browsers only allow the offline service worker, WebCrypto (PIN
  signing, encrypted report cache) and `Secure` cookies on HTTPS (or `localhost`). Plain
  `http://192.168…` will not work for terminals.
- ~200 MB disk, 512 MB RAM. Password hashing uses scrypt with 128 MB per attempt.

## 1. Install and build

```sh
git clone <your fork> p0rtal && cd p0rtal
npm ci
npm run build          # type-checks and builds the PWA into dist/
npm test               # optional: money/report/permission/API checks
```

## 2. Configure (environment)

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV=production` | yes | Secure `__Host-` cookies, HSTS |
| `APP_SECRET` | strongly recommended | ≥ 32 chars. Encrypts PIN keys, 2FA secrets and pay rates. If unset, one is generated into `DATA_DIR/.secret`. **Back it up — without it pay rates and PINs cannot be decrypted.** |
| `DATA_DIR` | no | Database + backups folder (default `./data`) |
| `PORT` / `HOST` | no | Default `8080` / `127.0.0.1`. Keep `127.0.0.1` behind a reverse proxy. |
| `TRUST_PROXY=1` | behind a proxy | Use the proxy's client IP for rate limiting |
| `SETUP_CODE` | no | Fix the first-run setup code instead of a random one |

Generate a secret:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## 3. Run as a service (systemd example)

```ini
# /etc/systemd/system/p0rtal.service
[Unit]
Description=p0rtal POS
After=network.target

[Service]
WorkingDirectory=/opt/p0rtal
Environment=NODE_ENV=production DATA_DIR=/var/lib/p0rtal TRUST_PROXY=1
EnvironmentFile=/etc/p0rtal.env          # APP_SECRET=...
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.ts
User=p0rtal
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/p0rtal

[Install]
WantedBy=multi-user.target
```

`chmod 600 /etc/p0rtal.env`, then `systemctl enable --now p0rtal`.

## 4. HTTPS with Caddy

Cloud / public domain (automatic Let's Encrypt certificates):

```
pos.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8080
}
```

On-premises without a public domain: use `tls internal` and install Caddy's root
certificate on each terminal, or point a real domain's DNS at the LAN IP and use the DNS
challenge. Server-Sent Events stream through Caddy without extra config.

Firewall: allow only 443 (and 80 for the redirect).

## 5. First run

1. Read the setup code from the log: `journalctl -u p0rtal | grep -A1 "setup code"`.
2. Open `https://pos.example.com` → enter the code, venue details and the owner account.
   The browser you set up on becomes the first enrolled terminal.
3. Owner: Settings → Security → turn on two-factor authentication. Consider
   Settings → Business → "Require 2FA for finance".
4. Add staff (Staff → Add person, with a PIN). Give managers a back-office login.
5. Each additional terminal: a manager signs in with their password on that device and
   taps **Enrol device**. Revoke lost or retired devices in Settings → Devices.

## 6. Backups ("cloud save" of the server itself)

- The server writes a consistent snapshot every day to `DATA_DIR/backups/` and keeps 14.
- Owners can download a snapshot any time: Settings → Security → Download backup.
- Copy `DATA_DIR/backups/` off the machine nightly (e.g. `restic`, `rclone`, or your cloud
  provider's volume snapshots). Store `APP_SECRET` separately (password manager).
- Restore: stop the service, copy a snapshot to `DATA_DIR/p0rtal.db` (delete `-wal`/`-shm`
  files), start the service. Devices re-sync automatically.

## 7. Updating

```sh
git pull && npm ci && npm run build && npm test && systemctl restart p0rtal
```

Open devices show **"A new version is ready — Update"**; nothing queued offline is lost.

## Security checklist

- [ ] HTTPS only, `NODE_ENV=production`, server bound to `127.0.0.1` behind the proxy
- [ ] `APP_SECRET` set and backed up separately from the database
- [ ] Owner and managers use 2FA; "Require 2FA for finance" on
- [ ] Only venue devices enrolled; revoke anything lost immediately
- [ ] Off-site copies of `DATA_DIR/backups/`
- [ ] Review Audit (voids, discounts, price overrides, timesheet edits, pay changes) weekly
