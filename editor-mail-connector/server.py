"""Remote MCP connector for the editor@wherepeteris.com Gmail mailbox.

Claude (claude.ai, the desktop and mobile apps) connects to this server as a
custom connector. Users sign in with Google; only ALLOWED_EMAIL is accepted.
Tools can read mail and create drafts. Nothing here sends mail.
"""

import base64
import html
import os
import re
from email.message import EmailMessage

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.auth.providers.google import GoogleProvider
from fastmcp.server.dependencies import get_access_token
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

ALLOWED_EMAIL = os.environ["ALLOWED_EMAIL"].strip().lower()
ALLOWED_DOMAIN = ALLOWED_EMAIL.split("@", 1)[1]
MAX_BODY_CHARS = 20_000

GMAIL_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
]

auth = GoogleProvider(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    base_url=os.environ["BASE_URL"].rstrip("/"),
    jwt_signing_key=os.environ["JWT_SIGNING_KEY"],
    required_scopes=GMAIL_SCOPES,
    # Offer only the Workspace account at Google's account picker.
    extra_authorize_params={
        "hd": ALLOWED_DOMAIN,
        "login_hint": ALLOWED_EMAIL,
    },
    # Only Claude may complete the sign-in flow.
    allowed_client_redirect_uris=[
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback",
    ],
)

mcp = FastMCP(
    name="WPI Editor Mail",
    instructions=(
        f"Gmail tools for the {ALLOWED_EMAIL} mailbox (Where Peter Is). "
        "This is separate from the user's personal Gmail. Use Gmail search "
        "syntax for queries. Drafts are created, never sent."
    ),
    auth=auth,
)


def _gmail():
    token = get_access_token()
    if token is None:
        raise ToolError("Not signed in.")
    email = (token.claims.get("email") or "").lower()
    if email != ALLOWED_EMAIL:
        raise ToolError(f"This connector only serves {ALLOWED_EMAIL}; signed in as {email or 'unknown'}.")
    return build("gmail", "v1", credentials=Credentials(token=token.token), cache_discovery=False)


def _headers(payload, names=("From", "To", "Cc", "Date", "Subject", "Message-ID", "References")):
    wanted = {n.lower(): n for n in names}
    out = {}
    for h in payload.get("headers", []):
        key = wanted.get(h["name"].lower())
        if key:
            out[key] = h["value"]
    return out


def _decode(data):
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")


def _html_to_text(s):
    s = re.sub(r"(?is)<(script|style).*?</\1>", "", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</tr>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\n{3,}", "\n\n", html.unescape(s)).strip()


def _body(payload):
    """Return the plain-text body, falling back to stripped HTML."""
    plain, rich = [], []

    def walk(part):
        mime = part.get("mimeType", "")
        data = part.get("body", {}).get("data")
        if data and mime == "text/plain":
            plain.append(_decode(data))
        elif data and mime == "text/html":
            rich.append(_decode(data))
        for sub in part.get("parts", []):
            walk(sub)

    walk(payload)
    text = "\n".join(plain) if plain else _html_to_text("\n".join(rich))
    if len(text) > MAX_BODY_CHARS:
        text = text[:MAX_BODY_CHARS] + "\n[... truncated]"
    return text


def _attachments(payload):
    found = []

    def walk(part):
        if part.get("filename"):
            found.append({"filename": part["filename"], "mime_type": part.get("mimeType"),
                          "size": part.get("body", {}).get("size")})
        for sub in part.get("parts", []):
            walk(sub)

    walk(payload)
    return found


def _message_dict(msg):
    payload = msg.get("payload", {})
    return {
        "id": msg["id"],
        "thread_id": msg["threadId"],
        "labels": msg.get("labelIds", []),
        **_headers(payload),
        "body": _body(payload),
        "attachments": _attachments(payload),
    }


@mcp.tool
def search_threads(query: str = "", max_results: int = 10, page_token: str | None = None) -> dict:
    """Search editor@wherepeteris.com mail with Gmail search syntax
    (e.g. 'is:unread newer_than:2d', 'from:someone@example.com', 'subject:submission').
    Returns thread ids with the latest message's sender, subject, date and snippet."""
    gmail = _gmail()
    resp = gmail.users().threads().list(
        userId="me", q=query, maxResults=max(1, min(max_results, 50)), pageToken=page_token
    ).execute()
    threads = []
    for t in resp.get("threads", []):
        full = gmail.users().threads().get(
            userId="me", id=t["id"], format="metadata", metadataHeaders=["From", "Subject", "Date"]
        ).execute()
        last = full["messages"][-1]
        threads.append({
            "thread_id": t["id"],
            "message_count": len(full["messages"]),
            "snippet": html.unescape(last.get("snippet", "")),
            "labels": last.get("labelIds", []),
            **_headers(last.get("payload", {}), ("From", "Subject", "Date")),
        })
    return {"threads": threads, "next_page_token": resp.get("nextPageToken")}


@mcp.tool
def get_thread(thread_id: str) -> dict:
    """Read every message in a thread, with headers, plain-text body and attachment names."""
    thread = _gmail().users().threads().get(userId="me", id=thread_id, format="full").execute()
    return {"thread_id": thread_id, "messages": [_message_dict(m) for m in thread["messages"]]}


@mcp.tool
def get_message(message_id: str) -> dict:
    """Read a single message by id."""
    msg = _gmail().users().messages().get(userId="me", id=message_id, format="full").execute()
    return _message_dict(msg)


@mcp.tool
def list_labels() -> list[dict]:
    """List the mailbox's labels (system and user-created)."""
    resp = _gmail().users().labels().list(userId="me").execute()
    return [{"id": l["id"], "name": l["name"], "type": l.get("type")} for l in resp.get("labels", [])]


def _save_draft(gmail, mime, thread_id=None):
    raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
    message = {"raw": raw}
    if thread_id:
        message["threadId"] = thread_id
    draft = gmail.users().drafts().create(userId="me", body={"message": message}).execute()
    return {"draft_id": draft["id"], "message_id": draft["message"]["id"],
            "note": "Saved to Drafts in editor@wherepeteris.com. Not sent."}


@mcp.tool
def create_draft(to: str, subject: str, body: str, cc: str = "", bcc: str = "") -> dict:
    """Create a new draft (not sent) from editor@wherepeteris.com.
    'to', 'cc' and 'bcc' are comma-separated addresses."""
    mime = EmailMessage()
    mime["From"] = ALLOWED_EMAIL
    mime["To"] = to
    if cc:
        mime["Cc"] = cc
    if bcc:
        mime["Bcc"] = bcc
    mime["Subject"] = subject
    mime.set_content(body)
    return _save_draft(_gmail(), mime)


@mcp.tool
def create_reply_draft(message_id: str, body: str, reply_all: bool = False) -> dict:
    """Draft a reply (not sent) to a message, threaded under the original."""
    gmail = _gmail()
    orig = gmail.users().messages().get(
        userId="me", id=message_id, format="metadata",
        metadataHeaders=["From", "Reply-To", "To", "Cc", "Subject", "Message-ID", "References"],
    ).execute()
    h = _headers(orig["payload"], ("From", "Reply-To", "To", "Cc", "Subject", "Message-ID", "References"))
    subject = h.get("Subject", "")
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"

    mime = EmailMessage()
    mime["From"] = ALLOWED_EMAIL
    mime["To"] = h.get("Reply-To") or h.get("From", "")
    if reply_all:
        others = [a.strip() for a in f"{h.get('To', '')},{h.get('Cc', '')}".split(",")
                  if a.strip() and ALLOWED_EMAIL not in a.lower()]
        if others:
            mime["Cc"] = ", ".join(others)
    mime["Subject"] = subject
    if h.get("Message-ID"):
        mime["In-Reply-To"] = h["Message-ID"]
        mime["References"] = f"{h.get('References', '')} {h['Message-ID']}".strip()
    mime.set_content(body)
    return _save_draft(gmail, mime, thread_id=orig["threadId"])


if __name__ == "__main__":
    mcp.run(transport="http", host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), path="/mcp")
