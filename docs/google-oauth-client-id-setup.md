# Google OAuth Client ID Setup

Reference guide for creating and configuring a Google OAuth 2.0 Client ID for PG Hub Tech.

---

## Step 1 — Create / select a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com) signed in as `pradhap.ganesan.java@gmail.com`
2. Top-left dropdown → **New Project** → name it `pg-hub-tech` → **Create**

---

## Step 2 — Enable the required APIs

1. Left menu → **APIs & Services** → **Library**
2. Search and enable each:
   - `Google Sheets API` — read/write spreadsheet data (backend)
   - `Google Drive API` — list user's sheets in picker, create new sheets
   - `Google People API` — user profile and email (for sign-in)

---

## Step 3 — Configure OAuth consent screen

1. Left menu → **APIs & Services** → **OAuth consent screen**
2. User Type: **External** → **Create**
3. Fill in:
   - App name: `PG Hub Tech`
   - User support email: `pradhap.ganesan.java@gmail.com`
   - Developer contact email: same
4. **Scopes step** → **Add or Remove Scopes** → add all of the following:
   ```
   https://www.googleapis.com/auth/spreadsheets
   https://www.googleapis.com/auth/drive.metadata.readonly
   https://www.googleapis.com/auth/drive.file
   https://www.googleapis.com/auth/userinfo.email
   https://www.googleapis.com/auth/userinfo.profile
   ```
   Click **Update** → **Save and Continue**
5. **Test users** step → **Add users** → add `pradhap.ganesan.java@gmail.com`
6. Finish

> These scopes must match what the app requests in `portal/src/lib/gauth.ts` inside `initTokenClient`. Missing scopes cause Google to block or warn during sign-in.

---

## Step 4 — Create the OAuth Client ID

1. Left menu → **Credentials** → **+ Create Credentials** → **OAuth client ID**
2. Application type: **Web application**
3. Name: `pg-hub-tech`
4. Under **Authorized JavaScript origins** → **Add URI**:
   ```
   http://localhost:5173
   https://pradhapganesanjava.github.io
   ```
5. Leave **Authorized redirect URIs** blank — the app uses the GIS token flow (popup), not a redirect flow
6. Click **Create**
7. Copy the **Client ID** (looks like `xxxx.apps.googleusercontent.com`)

> Settings may take up to 5 minutes to propagate. If you see `origin_mismatch`, the requesting domain is not in the origins list — add it and wait.

---

## Step 5 — Update the app

Current client ID in `portal/src/services/config.ts`:

```ts
const DEFAULT_CLIENT_ID = '650455977557-q0tunhbtfb2qabnhts5q6dac47b2q3iq.apps.googleusercontent.com'
```

Or override via environment variable at build time:

```bash
VITE_GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
```

Add the secret in GitHub repo → **Settings** → **Secrets and variables** → **Actions** → `GOOGLE_CLIENT_ID`.

---

## Notes

- While the app is in **Testing** mode on the consent screen, only users listed under **Test users** can sign in.
- To allow any Google account, publish the app (consent screen → **Publish App**). Google may require verification for sensitive scopes.
- **Authorized redirect URIs are not required** — this app uses the GIS token flow which returns the access token via a JS callback in a popup, no redirect needed.
