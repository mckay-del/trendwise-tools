# Using the same books from another computer (Tailscale)

One computer keeps the books; call it the **main computer**. Your other computers open them in a web browser over **Tailscale**, a private, encrypted network that only your own devices can join. Nothing is installed on the other computers except Tailscale, nothing is exposed to the internet, and there is only ever one copy of the books.

```
 Other computer (home / laptop)                       Main computer (office)
 ┌──────────────────────────┐   encrypted Tailscale   ┌─────────────────────────────┐
 │ Browser → https://…ts.net│ ──────────────────────▶ │ Tailscale → Trendwise Ledger │
 └──────────────────────────┘     (your devices only) │            → ledger.db       │
                                                        └─────────────────────────────┘
```

Setup takes about 15 minutes, once.

---

## Part 1: on the main computer

1. **Install Tailscale.** Go to https://tailscale.com/download/windows, install, and sign in. Use the same account (Google, Microsoft, etc.) on every computer you'll use; the free Personal plan is enough.
2. **Turn on HTTPS for your Tailscale network** (one-time). Open https://login.tailscale.com/admin/dns:
   - Make sure **MagicDNS** is **enabled**.
   - Under **HTTPS Certificates**, click **Enable HTTPS**.
3. **Keep the computer awake.** Open *Settings → System → Power & battery → Screen and sleep* and set **"When plugged in, put my device to sleep after"** to **Never**. The screen can still turn off.
4. **Start the ledger automatically.** In the `apps\ledger` folder, double-click **`Start Automatically With Windows.bat`**. From now on the ledger starts quietly whenever you sign in to Windows. Run **`Start Ledger.bat`** once now so it's running.
5. **Share it.** Double-click **`Share With My Other Computers.bat`**. It shows an address like:
   ```
   https://mckay-desktop.tail1234.ts.net
   ```
   Write it down. That's the address for your other computers. The setting survives restarts.
6. **Create a login for each person** (if someone else will use it). In the ledger: **Settings → Manage users → Invite user**. Use **Accountant** or **Standard** for staff; keep **Admin** for yourself.

## Part 2: on each other computer

1. Install Tailscale from https://tailscale.com/download and sign in with the **same Tailscale account**. (To give a staff member access without sharing your account, use the Tailscale admin console's **Users → Invite users**.)
2. Open the address from Part 1, step 5, in Chrome or Edge, and sign in with your ledger login.
3. Optional: make it feel like an app. In Edge choose **⋯ → Apps → Install this site as an app**; in Chrome choose **⋮ → Cast, save and share → Install page as app**. You get a "Trendwise Ledger" icon in the Start menu.

That's it. You and anyone you've invited now work on the same live books.

---

## Good to know

- **The main computer must be on, signed in, and running the ledger.** If the other computer shows *"502 Bad Gateway"* or can't connect, the ledger isn't running on the main computer (or that computer is asleep or off).
- **Two people at once is fine.** If two people edit the *same* transaction at the same time, the second person to save gets a message asking them to reload, so nobody's changes are silently overwritten.
- **Backups and updates happen on the main computer only.** The books never leave it except in your encrypted backups.
- **To stop sharing,** double-click **`Stop Sharing.bat`** on the main computer.
- **To stop the automatic start,** press **Win + R**, type `shell:startup`, and delete **Trendwise Ledger**.
- **Never** turn on Tailscale **Funnel** for the ledger. Funnel publishes it to the whole internet, while `serve` (what the helper uses) keeps it private to your devices.
- **Don't** try to share the books by putting the database in OneDrive or Dropbox and running the app on two computers. The copies overwrite each other and can corrupt the books.

## Troubleshooting

| What you see | What to do |
|---|---|
| The helper says HTTPS isn't enabled, or the serve command fails | Part 1, step 2: enable MagicDNS and HTTPS certificates, then run the helper again |
| Other computer: "This site can't be reached" | Is Tailscale running and signed in on **both** computers (icon in the system tray)? Same Tailscale account or invited user? |
| Other computer: "502 Bad Gateway" | The ledger isn't running on the main computer. Run `Start Ledger.bat` there |
| Signed out every so often | Sessions last 14 days; just sign in again |
| Main computer was replaced | Restore your latest encrypted backup on the new computer (see README → Backups), then repeat Part 1 |
