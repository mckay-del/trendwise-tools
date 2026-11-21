# Connecting Google accounts to McKay's Taskboard

This is a one-time setup, about 15 minutes. You create one private "Google app" that every account signs in through, then connect each account from the board.

The board asks Google for:

| Permission | Why |
|---|---|
| Read email (`gmail.readonly`) | Find emails that need action (from the next version) |
| See calendars (`calendar.readonly`) | Find meetings to prepare for or respond to (from the next version) |
| Manage tasks (`tasks`) | Show your Google Tasks on the board and send board tasks back, so they appear on your phone |

It can't send, delete or label email, and it can't change calendar events.

## 1. Create the Google Cloud project

Use your main Workspace account.

1. Go to **console.cloud.google.com**, then the project picker at the top, then **New project**. Name it `McKays Taskboard` and click **Create**, then select it.
2. Open **APIs & Services → Library** and enable each of these: **Gmail API**, **Google Calendar API**, **Google Tasks API**.

## 2. Set up sign-in (Google Auth Platform / "OAuth consent screen")

1. Open **APIs & Services → OAuth consent screen**. Newer consoles call this **Google Auth Platform**.
2. **Branding:**
   - App name `McKay's Taskboard`
   - Your email as the support and developer contact
3. **Audience:** choose **External**. "Internal" only works for accounts in this one domain, and your accounts are on several domains.
4. **Audience → Publish app**, so the status reads **In production**.
   - Do this step. In "Testing", Google signs every account out of the board after 7 days.
   - You don't need to submit the app for Google's verification. It's a private app with one user.
5. **Data access → Add or remove scopes.** Add:
   - `.../auth/gmail.readonly`
   - `.../auth/calendar.readonly`
   - `.../auth/tasks`
   - `openid`
   - `.../auth/userinfo.email`

## 3. Create the OAuth client

1. Open **Clients** (or **Credentials → Create credentials → OAuth client ID**).
2. Set **Application type** to **Web application**, and name it `Taskboard`.
3. Under **Authorized redirect URIs**, paste the address from the board's **Settings → Google app** box:
   - On this computer it's `http://127.0.0.1:3100/oauth/callback`.
   - If you also open the board through the Tailscale server, add its address too, for example `https://taskboard.your-tailnet.ts.net/oauth/callback`. The address in the box always matches how you opened the board.
4. Click **Create**, then copy the **Client ID** and **Client secret**.
5. In the board, open **Settings → Google app**, paste both and click **Save Google app**. The secret is stored encrypted.

## 4. Allow the app in each Workspace domain

Do this in the **Admin console of every domain** whose account you'll connect. It stops Workspace from blocking an app it doesn't know.

1. Go to **admin.google.com → Security → Access and data control → API controls**.
2. Choose **Manage Third-Party App Access → Configure new app**.
3. Search for the **Client ID** from step 3 and select the app.
4. Choose who it applies to: the whole domain, or just your organizational unit.
5. Set the access to **Trusted** and click **Finish**.

If someone else administers a domain, send them the Client ID and these steps.

## 5. Connect your accounts

1. In the board, open **Settings → Connect Google account**.
2. Sign in, and **tick every box** on Google's permission screen. If one is left unticked, the board asks you to try again.
   - You might see "Google hasn't verified this app". That's expected for a private app: choose **Advanced → Go to McKay's Taskboard**.
3. Repeat for each account. If Google signs you straight into the wrong account, use **Use another account**.

The first sync starts right away:
- Open tasks from every list in each account appear on the board.
- Board tasks go to a list called **Taskboard** in your **Primary** account. You can change which account is Primary, and the list name, in Settings.

## Troubleshooting

| What you see | What to do |
|---|---|
| `redirect_uri_mismatch` from Google | The address in Settings → Google app isn't listed in the OAuth client (step 3). Add it exactly. |
| "Access blocked: … has not completed the Google verification process" | The app is still in **Testing** (step 2.4), or the domain hasn't trusted it (step 4). |
| An account shows **Reconnect** | Google stopped accepting its sign-in (password change, access removed, or the app was in Testing). Click **Reconnect**. |
| Accounts all need reconnecting after moving computers | The sign-ins are encrypted with `secret.key` in the data folder. Copy that file along with `taskboard.db`, or just reconnect. |
