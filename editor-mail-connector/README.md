# WPI Editor Mail connector

A small hosted connector that lets Claude (claude.ai and the desktop and mobile
apps) read the **editor@wherepeteris.com** mailbox. It runs next to the built-in
Gmail connector, which stays on mfjlewis@gmail.com, so Claude can see both inboxes.

Tools:
- Read: `search_threads`, `get_thread`, `get_message`, `list_labels`
- Draft: `create_draft`, `create_reply_draft`
- Send: `send_message`, `send_reply`, `send_draft`

Sending is immediate and can't be undone. Each send tool tells Claude to show
you the exact recipients, subject and body and wait for your go-ahead. In
Claude's connector settings you can also set the three send tools to
**Needs approval**, so every send asks you first.

Security:
- You sign in with Google. The Google app is set to **Internal**, so only
  wherepeteris.com accounts can authorize, and the server rejects every account
  except `ALLOWED_EMAIL`.
- Only Claude's sign-in redirect URLs are accepted.
- Google tokens are stored encrypted on the server's storage volume.

## One-time setup (about 30 minutes)

You need admin access to the wherepeteris.com Google Workspace and a Google
Cloud project billed to it. Cloud Run's free tier will cover this usage.

### 1. Google Cloud project and Gmail API
1. Sign in to https://console.cloud.google.com as editor@wherepeteris.com.
2. Create a project, for example `wpi-editor-mail`.
3. Go to **APIs & Services → Library** and enable the **Gmail API**.

### 2. OAuth consent screen
**APIs & Services → OAuth consent screen** (now called *Google Auth Platform*):
- User type: **Internal**. Being internal means Google doesn't need to verify the app.
- App name: `WPI Editor Mail`, support email: editor@wherepeteris.com.
- Under **Data access**, add these scopes: `openid`, `.../auth/userinfo.email`,
  `.../auth/gmail.readonly`, `.../auth/gmail.compose`.

### 3. Deploy to Cloud Run
In Cloud Shell (the `>_` button in the console), run:

```bash
git clone https://github.com/mfjlewis/wpi-daily-listen.git
cd wpi-daily-listen/editor-mail-connector

PROJECT=$(gcloud config get-value project)
REGION=us-central1
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# Storage that keeps your sign-in across restarts
gcloud storage buckets create gs://$PROJECT-editor-mail-state --location=$REGION

# First deploy with placeholder secrets, just to learn the service URL
gcloud run deploy editor-mail --source . --region $REGION --allow-unauthenticated \
  --max-instances 1 \
  --add-volume name=state,type=cloud-storage,bucket=$PROJECT-editor-mail-state \
  --add-volume-mount volume=state,mount-path=/data \
  --set-env-vars GOOGLE_CLIENT_ID=placeholder,GOOGLE_CLIENT_SECRET=placeholder,BASE_URL=https://placeholder,ALLOWED_EMAIL=editor@wherepeteris.com,JWT_SIGNING_KEY=$(python3 -c "import secrets;print(secrets.token_urlsafe(48))")

URL=$(gcloud run services describe editor-mail --region $REGION --format='value(status.url)')
echo $URL
```

`--allow-unauthenticated` only lets Claude reach the server. Every tool
call still requires your Google sign-in.

### 4. Create the OAuth client
**APIs & Services → Credentials → Create credentials → OAuth client ID**:
- Type: **Web application**
- Authorized redirect URI: `<URL>/auth/callback` (the URL printed above)

Copy the client ID and secret, then update the service:

```bash
gcloud run services update editor-mail --region $REGION \
  --update-env-vars GOOGLE_CLIENT_ID=<id>,GOOGLE_CLIENT_SECRET=<secret>,BASE_URL=$URL
```

(Optional: keep the secret in Secret Manager and use `--update-secrets` instead of an env var.)

### 5. Add it to Claude
1. Go to https://claude.ai/customize/connectors → **Add custom connector**.
2. Name: `WPI Editor Mail`. URL: `<URL>/mcp`.
3. Click **Connect** and sign in as editor@wherepeteris.com.
4. In a chat, turn the connector on from the tools menu. Then ask, for example:
   "Check the editor inbox for unread submissions from the last two days."

If you use a Team or Enterprise Claude plan, an org owner may need to add the
custom connector first.

## Local development

```bash
cp .env.example .env   # fill in values; BASE_URL=http://localhost:8080
pip install -r requirements.txt
set -a; . ./.env; set +a; python server.py
```

For a local test, add `http://localhost:8080/auth/callback` to the OAuth
client's redirect URIs.
