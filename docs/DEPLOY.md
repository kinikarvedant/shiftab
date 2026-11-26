# Deploying Shiftab

One Shiftab server = one venue. Devices work offline and sync to the server whenever they
can reach it. The server can live in the cloud (a small VPS is plenty) or on a machine in
the venue.

## Requirements

- **Node.js ≥ 22.18** (uses built-in TypeScript stripping and `node:sqlite`; no native modules).
- **HTTPS is mandatory.** Browsers only allow the offline service worker, WebCrypto (PIN
  signing, encrypted report cache) and `Secure` cookies on HTTPS (or `localhost`). Plain
  `http://192.168…` will not work for terminals.
- ~200 MB disk, 512 MB RAM. Password hashing uses scrypt with 128 MB per attempt.
- A long-running process with a persistent disk (SQLite + live updates). Serverless hosts
  (Vercel, Netlify, Lambda) won't work. A VPS, or Fly.io / Railway / Render with a volume, will.

## Where to host

| | Cloud VPS + your domain (recommended) | Mini PC in the venue + Cloudflare Tunnel |
|---|---|---|
| Reach it from | anywhere: owner's phone at home, a second venue | anywhere (through the tunnel) |
| HTTPS | Caddy gets certificates automatically | the tunnel provides it; no ports opened |
| Venue internet goes down | terminals keep trading offline and catch up when it's back | same: terminals reach the server through the internet too |
| You look after | one small server | the PC, its power, its backups |

Either way, give it a real domain (e.g. `pos.yourvenue.com`, or one venue per subdomain if you
run several), because every device must reach the *same* HTTPS address. One server serves one venue.

## 1. Install and build

```sh
git clone <your fork> shiftab && cd shiftab
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
# /etc/systemd/system/shiftab.service
[Unit]
Description=Shiftab POS
After=network.target

[Service]
WorkingDirectory=/opt/shiftab
Environment=NODE_ENV=production DATA_DIR=/var/lib/shiftab TRUST_PROXY=1
EnvironmentFile=/etc/shiftab.env          # APP_SECRET=...
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.ts
User=shiftab
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/shiftab

[Install]
WantedBy=multi-user.target
```

`chmod 600 /etc/shiftab.env`, then `systemctl enable --now shiftab`.

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

1. Read the setup code from the log: `journalctl -u shiftab | grep -A1 "setup code"`.
2. Open `https://pos.example.com` → enter the code, venue details and the owner account.
   The browser you set up on becomes the first enrolled terminal.
3. Owner: Settings → Security → turn on two-factor authentication. Consider
   Settings → Business → "Require 2FA for finance".
4. Add staff (Staff → Add person, with a PIN). Give managers a back-office login.
5. Each additional terminal: a manager signs in with their password on that device and
   taps **Enrol device**. Revoke lost or retired devices in Settings → Devices.

## 6. Setting up each device

**Install first, then enrol inside the installed app.** An installed app opens full-screen,
survives browser clean-ups, and on iPhone/iPad it has its *own* storage, separate from Safari:
a device enrolled in Safari is not enrolled in the home-screen app.

| Device | Install | Keep it a terminal |
|---|---|---|
| iPad / iPhone | Safari → open the address → Share → **Add to Home Screen** → open from the icon | Guided Access (Settings → Accessibility) locks it to the app; Auto-Lock "Never" while charging |
| Android tablet / phone | Chrome → ⋮ → **Install app** | Screen pinning, or a kiosk browser for dedicated terminals; "Stay awake" while charging |
| Windows / Mac / Chromebook | Chrome or Edge → install icon in the address bar | Dedicated terminal: `chrome --kiosk --app=https://pos.yourvenue.com` (or Windows Assigned Access) |
| Kitchen TV | Don't rely on the TV's own browser (old engines, poor offline support). Use a Google TV / Android TV stick with Chrome, or best, a mini PC or old laptop on HDMI running Chrome full-screen | Open **Kitchen** and sign in with a Kitchen-group PIN. Tap the course tabs to make it a station (e.g. Desserts, or Mains + Sides); each screen remembers its own. Or set up **kitchen stations** in Staff → Roles: each cook then sees their own station's dishes wherever they sign in, with a Whole order view. **S/M/L/XL** sets the text size for the viewing distance |

Then on every terminal:

1. Manager signs in with their password **in the installed app** → **Enrol device** → Lock.
2. Wait for the toast "can now work offline on this device" and the **Synced** pill. From
   then on the terminal works without a network.
3. Set the device clock to automatic. The server refuses changes from a clock that is ahead.

Personal devices (an owner checking reports from home) are **not** enrolled: just open the
address and use **Manager sign-in** with email, password and 2FA.

Keep it reliable:

- Never clear site data or use a private window on a terminal: unsynced orders live there
  until the pill says **Synced**.
- The pill tells you the state: **Synced**, **Offline · n queued** (still trading, will catch
  up), or **Sync paused** (tap it to see why, then **Sync now**; usually the device was revoked
  or its clock is wrong).
- Use any browser updated in the last couple of years (iOS/iPadOS 17+, current Chrome or Edge).
- When you deploy an update, each device installs it by itself the next time it locks (never
  mid-order); signed-in staff see **Update now** if they want it sooner.

## 7. Backups ("cloud save" of the server itself)

- The server writes a consistent snapshot every day to `DATA_DIR/backups/` and keeps 14.
- Owners can download a snapshot any time: Settings → Security → Download backup.
- Copy `DATA_DIR/backups/` off the machine nightly (e.g. `restic`, `rclone`, or your cloud
  provider's volume snapshots). Store `APP_SECRET` separately (password manager).
- Restore: stop the service, copy a snapshot to `DATA_DIR/p0rtal.db` (the file keeps the project's first name),
  delete the `-wal`/`-shm` files next to it, and start the service. Devices re-sync automatically.

## 8. Updating

```sh
git pull && npm ci && npm run build && npm test && systemctl restart shiftab
```

Each device installs the new version the next time it locks (or on **Update now**); nothing queued
offline is lost.

## Security checklist

- [ ] HTTPS only, `NODE_ENV=production`, server bound to `127.0.0.1` behind the proxy
- [ ] `APP_SECRET` set and backed up separately from the database
- [ ] Owner and managers use 2FA; "Require 2FA for finance" on
- [ ] Only venue devices enrolled; revoke anything lost immediately
- [ ] Off-site copies of `DATA_DIR/backups/`
- [ ] Review Audit (voids, discounts, price overrides, timesheet edits, pay changes) weekly
