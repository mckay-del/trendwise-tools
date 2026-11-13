# Running Trendwise Ledger on a cloud server

The books live on a small always-on server (for example a DigitalOcean Droplet). Every computer, office or home, opens them in a browser over **Tailscale**, so no computer of yours has to stay on. The server isn't reachable from the public internet; only devices signed in to your Tailscale account can open the ledger.

Cost: about $6/month for the server, plus about $1.20/month for DigitalOcean weekly backups.

## 1. Create the server (DigitalOcean)

Create → **Droplets**:
- Region **San Francisco (SFO3)** · Image **Ubuntu 24.04 (LTS) x64** · **Basic / Regular / 1 GB RAM**
- **Weekly backups: on** · Authentication: **Password** (long, random, saved in your password manager)
- Monitoring on · IPv6 off · no initialization script · hostname `trendwise-ledger`

Also turn on two-factor authentication for your DigitalOcean account (Settings → Security).

## 2. Run the setup (about 10 minutes)

1. Make sure **Tailscale** is installed and signed in on your computer (https://tailscale.com/download).
2. In DigitalOcean open the Droplet and click **Console** (top right). A black terminal opens, already logged in as root.
3. Paste this line and press Enter. To paste, right-click → Paste, or Ctrl+Shift+V.
   ```
   curl -fsSL https://raw.githubusercontent.com/mckay-del/trendwise-tools/main/apps/ledger/deploy/setup-server.sh | bash
   ```
4. Answer its three prompts:
   - **Backup passphrase:** it shows a generated passphrase. Save it in your password manager, then press Enter.
   - **Tailscale sign-in:** it shows a `https://login.tailscale.com/a/…` link. Open it on your computer, sign in with your usual Tailscale account, and approve.
   - **HTTPS:** if asked, open https://login.tailscale.com/admin/dns, enable **MagicDNS** and **HTTPS Certificates**, then press Enter.
   - *(Only if the GitHub repository is private)* It shows a read-only key and tells you where to paste it in GitHub.
5. It finishes with your address, like `https://trendwise-ledger.tail1234.ts.net`. Bookmark it.

## 3. Move your books onto the server

1. On the computer where you use the ledger today: **Settings → Backup → Download encrypted backup**. Choose a passphrase and remember it.
2. Open the server address. On the first screen, open **"Moving your books from another computer? Restore a backup instead"**, choose the backup file, enter that passphrase, and click **Restore backup**.
3. Sign in with your usual email and password. All companies and users are there.
4. On your old computer, stop using the local copy so nobody edits the wrong books by mistake. Remove `Start Automatically With Windows` if you set it up (Win+R → `shell:startup` → delete "Trendwise Ledger").

## 4. Your other computers

Install Tailscale, sign in with the same account, and open the bookmark. To invite a staff member: add them in Tailscale (admin console → Users → Invite), then create their ledger login under **Settings → Manage users**.

---

## Looking after it

| Task | How |
|---|---|
| Check it's healthy | DigitalOcean → Droplet → **Console**, type `ledger-status` |
| Install the newest version | Console, type `ledger-update` (takes a backup first) |
| Nightly backups | Automatic, kept 30 days on the server, encrypted with the server backup passphrase. DigitalOcean's weekly backups cover loss of the whole server. For an extra off-site copy, use **Settings → Download encrypted backup** now and then |
| Security updates | Automatic. If an update needs a reboot, it happens around 3–4 AM Pacific and the ledger restarts by itself |
| Stop paying | Download a final encrypted backup, then delete the Droplet in DigitalOcean |

**What is exposed to the internet?** Only SSH, rate-limited, for DigitalOcean's console. The ledger listens only inside the server and is published only on your private Tailscale network, over HTTPS. Never enable Tailscale **Funnel** for it.

**Restoring a server backup:** nightly files are in `/var/lib/trendwise-ledger/backups`. Restoring one uses the same "Restore a backup" screen on a fresh installation, with the **server backup passphrase**.
