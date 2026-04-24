"""
AlertTracker LAN server
-----------------------
Serves the static site AND a shared data API so every PC on the same
network reads/writes the same records.

Data is stored locally in a SQLite database file (server_data.db) that
lives inside the project folder. Copying the whole project folder to
another PC carries the data with it.

Endpoints:
    GET /api/alerts        -> returns the shared JSON array
    PUT /api/alerts        -> replaces the shared JSON array (body = JSON array)
    anything else          -> static file from this folder

Run:
    python server.py
    (optional)  python server.py 8080

Then other PCs on the LAN open:
    http://<this-pc-ip>:3000
"""

import datetime
import json
import mimetypes
import os
import random
import socket
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT       = os.path.dirname(os.path.abspath(__file__))
DB_FILE    = os.path.join(ROOT, "server_data.db")
DORK_DB    = os.path.join(ROOT, "dorking_data.db")
JSON_FILE  = os.path.join(ROOT, "server_data.json")   # legacy, used once for migration
PORT       = int(sys.argv[1]) if len(sys.argv) > 1 else 3000

# Ticket ID generator — matches Code.py's path & line format exactly.
TICKET_DIR  = os.path.join(os.path.expanduser("~"), "Documents", "Generated Code")
TICKET_FILE = os.path.join(TICKET_DIR, "generated_codes.txt")

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("image/svg+xml",          ".svg")


def _connect(db_path=None):
    # check_same_thread=False so the ThreadingHTTPServer worker threads can share connections.
    # Each call still opens its own short-lived connection, which is the safe pattern with SQLite.
    conn = sqlite3.connect(db_path or DB_FILE, timeout=30, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")   # better concurrent reads while a write is happening
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


# Default dorks seeded on first run — curated common attack-surface queries
DEFAULT_DORKS = [
    # Admin / Login pages
    {"category": "Admin & Login", "title": "Generic admin login pages", "query": 'inurl:admin intitle:"login"', "description": "Finds generic admin login portals."},
    {"category": "Admin & Login", "title": "WordPress login (wp-admin)", "query": 'inurl:"/wp-admin/" intitle:"Log In"', "description": "Exposed WordPress admin login pages."},
    {"category": "Admin & Login", "title": "WordPress login (wp-login.php)", "query": 'inurl:"wp-login.php"', "description": "Direct WordPress login endpoints."},
    {"category": "Admin & Login", "title": "Joomla administrator login", "query": 'inurl:"/administrator/" intitle:"Joomla"', "description": "Joomla admin backend login."},
    {"category": "Admin & Login", "title": "Drupal user login", "query": 'inurl:"/user/login" "Drupal"', "description": "Drupal login pages."},
    {"category": "Admin & Login", "title": "cPanel login", "query": 'inurl:":2082" OR inurl:":2083" intitle:"cPanel"', "description": "cPanel hosting control panel."},
    {"category": "Admin & Login", "title": "phpMyAdmin login", "query": 'inurl:"phpmyadmin" intitle:"phpMyAdmin"', "description": "Exposed phpMyAdmin consoles."},
    {"category": "Admin & Login", "title": "Router / device login", "query": 'intitle:"Router" inurl:"login" -site:github.com', "description": "Consumer router admin pages."},

    # Directory listings
    {"category": "Directory Listing", "title": "Open directory index", "query": 'intitle:"index of" "parent directory"', "description": "Classic Apache / nginx directory listings."},
    {"category": "Directory Listing", "title": "Backups exposed", "query": 'intitle:"index of" (backup OR bak OR old)', "description": "Exposed backup directories."},
    {"category": "Directory Listing", "title": "Uploads directory", "query": 'intitle:"index of" "/uploads/"', "description": "Exposed upload folders."},

    # Exposed / sensitive files
    {"category": "Exposed Files", "title": ".env files", "query": 'filetype:env "DB_PASSWORD"', "description": "Leaked application environment files."},
    {"category": "Exposed Files", "title": ".git repositories", "query": 'inurl:".git" intitle:"index of"', "description": "Exposed .git directories."},
    {"category": "Exposed Files", "title": "SQL dumps", "query": 'filetype:sql "INSERT INTO" (password OR passwd OR pwd)', "description": "Leaked SQL database dumps."},
    {"category": "Exposed Files", "title": "Log files", "query": 'filetype:log inurl:"access.log"', "description": "Exposed web server logs."},
    {"category": "Exposed Files", "title": "Config files", "query": 'ext:conf OR ext:cnf OR ext:ini "password"', "description": "Exposed config files containing secrets."},
    {"category": "Exposed Files", "title": "WordPress wp-config.php backup", "query": 'inurl:"wp-config.php.bak" OR inurl:"wp-config.php~"', "description": "Leaked WordPress configuration backups."},
    {"category": "Exposed Files", "title": "SSH private keys", "query": 'intitle:"index of" "id_rsa" -pub', "description": "Exposed SSH private keys."},
    {"category": "Exposed Files", "title": "AWS credentials", "query": '"aws_access_key_id" "aws_secret_access_key" ext:csv OR ext:txt', "description": "Leaked AWS credentials."},

    # Errors / debug info
    {"category": "Errors & Debug", "title": "PHP info pages", "query": 'intitle:"phpinfo()" "PHP Version"', "description": "Exposed phpinfo() pages."},
    {"category": "Errors & Debug", "title": "PHP errors / warnings", "query": '"Warning: mysql_" OR "Fatal error:" ext:php', "description": "Pages leaking PHP errors/stack traces."},
    {"category": "Errors & Debug", "title": "Laravel debug bar / Ignition", "query": 'intext:"Whoops, looks like something went wrong" "Laravel"', "description": "Laravel in debug mode."},
    {"category": "Errors & Debug", "title": "Django debug page", "query": '"You are seeing this error because you have DEBUG = True"', "description": "Django apps running with DEBUG=True."},
    {"category": "Errors & Debug", "title": "ASP.NET detailed errors", "query": '"Server Error in" "/Application." inurl:aspx', "description": "ASP.NET detailed server error pages."},
    {"category": "Errors & Debug", "title": "WinDev / WebDev errors", "query": '"WD230Action" OR "WINDEV Error" OR "WebDev Error"', "description": "WinDev / WebDev stack traces."},

    # CMS-specific
    {"category": "CMS (WordPress)", "title": "Exposed WP readme.html", "query": 'inurl:"/readme.html" "WordPress"', "description": "Reveals WordPress version."},
    {"category": "CMS (WordPress)", "title": "Plugin directory listing", "query": 'intitle:"index of" "/wp-content/plugins/"', "description": "Exposed plugin directory (enumerate plugins)."},
    {"category": "CMS (WordPress)", "title": "Debug log", "query": 'inurl:"/wp-content/debug.log"', "description": "WordPress debug logs."},
    {"category": "CMS (Joomla)", "title": "Joomla configuration.php~ backup", "query": 'inurl:"configuration.php~" OR inurl:"configuration.php.bak"', "description": "Joomla config backups."},
    {"category": "CMS (Drupal)", "title": "Drupal CHANGELOG.txt", "query": 'inurl:"CHANGELOG.txt" "Drupal"', "description": "Reveals Drupal version."},

    # Servers / services
    {"category": "Servers & Services", "title": "Apache Tomcat manager", "query": 'intitle:"Apache Tomcat" inurl:"/manager/html"', "description": "Exposed Tomcat Manager app."},
    {"category": "Servers & Services", "title": "Jenkins dashboards", "query": 'intitle:"Dashboard [Jenkins]"', "description": "Exposed Jenkins CI dashboards."},
    {"category": "Servers & Services", "title": "Kibana dashboards", "query": 'intitle:"Kibana" inurl:":5601"', "description": "Exposed Kibana instances."},
    {"category": "Servers & Services", "title": "Grafana login", "query": 'intitle:"Grafana" inurl:"/login"', "description": "Exposed Grafana login pages."},
    {"category": "Servers & Services", "title": "Webcams (live view)", "query": 'inurl:"view/view.shtml"', "description": "Exposed network cameras."},

    # Vulnerabilities / misc
    {"category": "Vulnerabilities", "title": "Open redirect params", "query": 'inurl:"redirect=" OR inurl:"url=" OR inurl:"next="', "description": "Candidates for open-redirect testing."},
    {"category": "Vulnerabilities", "title": "SQLi candidate params", "query": 'inurl:"id=" OR inurl:"cat=" OR inurl:"pid="', "description": "URLs with common injectable params."},
    {"category": "Vulnerabilities", "title": "LFI candidate params", "query": 'inurl:"page=" OR inurl:"file=" OR inurl:"include="', "description": "URLs with file-include style params."},
    {"category": "Vulnerabilities", "title": "Exposed IDOR patterns", "query": 'inurl:"user_id=" OR inurl:"account=" OR inurl:"invoice="', "description": "Candidates for IDOR testing."},

    # SEO spam (hacked-site indicators)
    {"category": "SEO Spam", "title": "Pharma spam on .gov / .edu", "query": 'site:gov OR site:edu (viagra OR cialis OR "buy cheap")', "description": "Pharma keyword injection on government / education domains."},
    {"category": "SEO Spam", "title": "Casino / gambling spam", "query": 'site:gov OR site:edu (casino OR poker OR "slot online")', "description": "Gambling SEO spam injected into trusted domains."},
    {"category": "SEO Spam", "title": "Japanese SEO spam", "query": '"激安" OR "通販" site:-jp inurl:/', "description": "Japanese keyword spam (\"cheap\", \"mail order\") on non-.jp sites — classic hacked-site indicator."},
    {"category": "SEO Spam", "title": "Indonesian/SE Asia slot spam", "query": '("slot gacor" OR "situs slot" OR "judi online") site:gov OR site:edu', "description": "Indonesian gambling/slot SEO spam on trusted TLDs."},
    {"category": "SEO Spam", "title": "Replica / fake goods spam", "query": '("replica watches" OR "cheap nike" OR "louis vuitton outlet") site:gov OR site:edu', "description": "Counterfeit-goods SEO spam."},
    {"category": "SEO Spam", "title": "Hidden PHP spam pages", "query": 'inurl:"/wp-content/uploads/" ext:php (viagra OR casino OR slot)', "description": "Spam PHP files dropped into WordPress uploads."},
    {"category": "SEO Spam", "title": "Cloaked spam titles", "query": 'intitle:"buy" intitle:"online" intitle:"cheap" site:gov', "description": "Pages with spam titles on government domains (likely cloaking)."},
    {"category": "SEO Spam", "title": "Essay / homework spam", "query": '("write my essay" OR "essay writing service") site:edu', "description": "Essay-mill SEO spam injected into university sites."},
    {"category": "SEO Spam", "title": "Adult spam injections", "query": '("xxx" OR "porn" OR "escort") site:gov OR site:edu', "description": "Adult-keyword SEO spam on trusted TLDs."},
    {"category": "SEO Spam", "title": "Redirect-to-spam chains", "query": 'inurl:"?url=http" (casino OR viagra OR slot)', "description": "Open redirects abused for SEO spam laundering."},
]


def init_dork_db():
    with _connect(DORK_DB) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS dorks (
                id          TEXT PRIMARY KEY,
                pos         INTEGER NOT NULL,
                category    TEXT,
                title       TEXT,
                query       TEXT NOT NULL,
                description TEXT,
                created_at  TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dorks_pos ON dorks(pos)")
        conn.commit()

    # Seed defaults. If the table is empty, insert all of them. If it already
    # has records, only add defaults whose query isn't already present so that
    # user edits are preserved while newly-added default categories still appear.
    import time, uuid
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    existing = read_dorks()
    known = {d.get("query", "") for d in existing}
    missing = [d for d in DEFAULT_DORKS if d["query"] not in known]
    if not existing:
        merged = [{
            "id": uuid.uuid4().hex,
            "category": d["category"], "title": d["title"], "query": d["query"],
            "description": d.get("description", ""), "created_at": now,
        } for d in DEFAULT_DORKS]
        _dork_replace_all(merged)
    elif missing:
        new_entries = [{
            "id": uuid.uuid4().hex,
            "category": d["category"], "title": d["title"], "query": d["query"],
            "description": d.get("description", ""), "created_at": now,
        } for d in missing]
        _dork_replace_all(existing + new_entries)
        print(f"Seeded {len(new_entries)} new default dork(s).")


def read_dorks():
    with _connect(DORK_DB) as conn:
        rows = conn.execute(
            "SELECT id, category, title, query, description, created_at FROM dorks ORDER BY pos ASC"
        ).fetchall()
    return [
        {"id": r[0], "category": r[1] or "", "title": r[2] or "", "query": r[3] or "",
         "description": r[4] or "", "created_at": r[5] or ""}
        for r in rows
    ]


def _dork_replace_all(arr):
    rows = []
    for i, rec in enumerate(arr):
        if not isinstance(rec, dict):
            continue
        rid = rec.get("id")
        q   = rec.get("query")
        if not rid or not q:
            continue
        rows.append((
            str(rid), i,
            rec.get("category") or "",
            rec.get("title") or "",
            q,
            rec.get("description") or "",
            rec.get("created_at") or "",
        ))
    with _connect(DORK_DB) as conn:
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM dorks")
            conn.executemany(
                "INSERT OR REPLACE INTO dorks (id, pos, category, title, query, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def write_dorks(arr):
    _dork_replace_all(arr)


def init_db():
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS alerts (
                id   TEXT PRIMARY KEY,
                pos  INTEGER NOT NULL,
                data TEXT    NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_alerts_pos ON alerts(pos)")
        conn.commit()

    # One-time migration: if the DB is empty but the old JSON file exists, import it.
    with _connect() as conn:
        count = conn.execute("SELECT COUNT(*) FROM alerts").fetchone()[0]
    if count == 0 and os.path.exists(JSON_FILE):
        try:
            with open(JSON_FILE, "r", encoding="utf-8") as f:
                legacy = json.load(f)
            if isinstance(legacy, list) and legacy:
                _replace_all(legacy)
                print(f"Migrated {len(legacy)} records from server_data.json into SQLite.")
        except Exception as e:
            print("Legacy JSON migration skipped:", e)


def read_data():
    with _connect() as conn:
        rows = conn.execute("SELECT data FROM alerts ORDER BY pos ASC").fetchall()
    out = []
    for (raw,) in rows:
        try:
            out.append(json.loads(raw))
        except Exception:
            continue
    return out


def _replace_all(arr):
    """Replace the entire alerts table with the given list, in one transaction."""
    rows = []
    for i, rec in enumerate(arr):
        if not isinstance(rec, dict):
            continue
        rid = rec.get("id")
        if not rid:
            # Skip records with no id rather than silently overwriting; the frontend always assigns one.
            continue
        rows.append((str(rid), i, json.dumps(rec, ensure_ascii=False)))

    with _connect() as conn:
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM alerts")
            conn.executemany(
                "INSERT OR REPLACE INTO alerts (id, pos, data) VALUES (?, ?, ?)",
                rows,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def write_data(arr):
    _replace_all(arr)


def safe_static_path(url_path):
    """Resolve a URL path to an absolute file path, refusing anything outside ROOT."""
    rel = "/index.html" if url_path in ("", "/") else url_path
    rel = rel.split("?", 1)[0].split("#", 1)[0]
    candidate = os.path.normpath(os.path.join(ROOT, rel.lstrip("/\\")))
    # Proper containment check: candidate must equal ROOT or live under ROOT + sep.
    # Prevents "/proj" matching "/proj-other/..." via startswith().
    root_with_sep = ROOT + os.sep
    if candidate != ROOT and not candidate.startswith(root_with_sep):
        return None
    return candidate


# Filenames / patterns that must never be served over the static route.
# Compared case-insensitively so Windows' case-insensitive FS can't bypass.
_BLOCKED_STATIC = {
    "server_data.db", "server_data.db-wal", "server_data.db-shm", "server_data.json",
    "dorking_data.db", "dorking_data.db-wal", "dorking_data.db-shm",
}
# Source files and dotfiles must never leak over the static route.
_BLOCKED_EXTENSIONS = {".py", ".pyc", ".pyo", ".db", ".sqlite", ".sqlite3", ".env", ".ini"}


class Handler(BaseHTTPRequestHandler):
    server_version = "AlertTracker/1.1"

    # Silence the default noisy per-request logging; keep errors.
    def log_message(self, fmt, *args):
        if "code 4" in (fmt % args) or "code 5" in (fmt % args):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # Static site and API are served from the same origin, so CORS is unnecessary.
    def _cors(self):
        pass

    # --- API ---
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = self.path.split("?", 1)[0]
        if route == "/api/alerts":
            self._send_json(200, read_data()); return
        if route == "/api/dorks":
            self._send_json(200, read_dorks()); return
        if route == "/api/tickets":
            self._send_json(200, _ticket_history(limit=20)); return

        # Browsers auto-request these — serve/ignore silently instead of logging 404s.
        if route == "/favicon.ico":
            # Re-use logo.png as the favicon.
            path = os.path.join(ROOT, "logo.png")
            if os.path.isfile(path):
                with open(path, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_response(204); self.end_headers(); return

        # Chrome DevTools probes + stray source-map requests when DevTools is open.
        if (route.startswith("/.well-known/")
                or route.endswith(".map")
                or route == "/robots.txt"):
            self.send_response(204); self.end_headers(); return

        self._serve_static()

    def do_POST(self):
        route = self.path.split("?", 1)[0]
        if route != "/api/tickets":
            self.send_error(404); return

        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > 64 * 1024:
            self.send_error(413, "Payload too large"); return

        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(body, dict):
                raise ValueError("Body must be a JSON object")
            prefix = body.get("prefix", "INC:")
            date_str = body.get("date", "")
            if not isinstance(prefix, str) or len(prefix) > 32:
                raise ValueError("Invalid prefix")
            if not isinstance(date_str, str) or len(date_str) > 32:
                raise ValueError("Invalid date")
        except Exception as e:
            self._send_json(400, {"ok": False, "error": str(e)}); return

        result = generate_ticket(prefix, date_str)
        self._send_json(200 if result.get("ok") else 500, result)

    def do_PUT(self):
        route = self.path.split("?", 1)[0]
        if route not in ("/api/alerts", "/api/dorks"):
            self.send_error(404); return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 20 * 1024 * 1024:   # 20 MB hard cap
            self.send_error(413, "Payload too large"); return

        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw.decode("utf-8"))
            if not isinstance(parsed, list):
                raise ValueError("Body must be a JSON array")
            if route == "/api/alerts":
                write_data(parsed)
            else:
                write_dorks(parsed)
        except Exception as e:
            self._send_json(400, {"ok": False, "error": str(e)}); return

        self._send_json(200, {"ok": True, "count": len(parsed)})

    # --- Static files ---
    def _serve_static(self):
        path = safe_static_path(self.path)
        if path is None:
            self.send_error(403); return

        base_lower = os.path.basename(path).lower()
        ext_lower = os.path.splitext(base_lower)[1]

        # Never expose the database/legacy JSON, source files, or dotfiles.
        if (base_lower in _BLOCKED_STATIC
                or ext_lower in _BLOCKED_EXTENSIONS
                or base_lower.startswith(".")
                or "__pycache__" in path.lower().split(os.sep)):
            self.send_error(403); return

        if not os.path.isfile(path):
            self.send_error(404); return

        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(500); return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        # Security headers — X-Frame-Options only works as an HTTP header,
        # not via <meta http-equiv>, so the site is actually clickjack-protected now.
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self._cors()
        self.end_headers()
        self.wfile.write(data)


## -- Ticket ID Generator (ported from Code.py, same algorithm & file format) --

def _ticket_generate_mix_code():
    vowels     = 'AEIOU'
    consonants = 'BCDFGHJKLMNPQRSTVWXYZ'
    digits     = '0123456789'
    return (
        random.choice(consonants) +
        random.choice(vowels) +
        random.choice(consonants) +
        random.choice(digits) +
        random.choice(vowels) +
        random.choice(consonants)
    )


def _ticket_existing_codes():
    if not os.path.exists(TICKET_FILE):
        return set()
    codes = set()
    try:
        with open(TICKET_FILE, "r", encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if parts:
                    codes.add(parts[-1])
    except OSError:
        pass
    return codes


def _ticket_save_code(full_code):
    os.makedirs(TICKET_DIR, exist_ok=True)
    now = datetime.datetime.now()
    timestamp = now.strftime("[%Y-%m-%d][%H:%M:%S]")
    with open(TICKET_FILE, "a", encoding="utf-8") as f:
        f.write(f"{timestamp} {full_code}\n")
    return timestamp


def _ticket_history(limit=20):
    if not os.path.exists(TICKET_FILE):
        return []
    out = []
    try:
        with open(TICKET_FILE, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return []
    for line in lines[-limit:][::-1]:
        s = line.strip()
        if not s:
            continue
        parts = s.split()
        if len(parts) >= 2:
            out.append({"timestamp": " ".join(parts[:-1]), "code": parts[-1]})
    return out


def generate_ticket(prefix, date_str):
    prefix = "INC:" if prefix is None else str(prefix)
    date_str = "" if date_str is None else str(date_str).strip()
    if not date_str:
        date_str = datetime.date.today().strftime("%Y%m%d")

    existing = _ticket_existing_codes()
    for attempt in range(1, 1001):
        code = _ticket_generate_mix_code()
        full_code = f"{prefix}{date_str}-{code}"
        if full_code not in existing:
            timestamp = _ticket_save_code(full_code)
            return {
                "ok": True,
                "full_code": full_code,
                "code": code,
                "prefix": prefix,
                "date": date_str,
                "timestamp": timestamp,
                "attempts": attempt,
                "saved_to": TICKET_FILE,
            }
    return {"ok": False, "error": "Failed to generate a unique code after 1000 attempts. Please try again."}


def lan_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ip = info[4][0]
            if ":" in ip:               # skip IPv6
                continue
            if ip.startswith("127."):
                continue
            ips.add(ip)
    except Exception:
        pass
    return sorted(ips)


def main():
    init_db()
    init_dork_db()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("-" * 60)
    print(f"  AlertTracker server running on port {PORT}")
    print(f"  Alerts DB:  {DB_FILE}")
    print(f"  Dorks DB:   {DORK_DB}")
    print(f"  Tickets:    {TICKET_FILE}")
    print()
    print("  Open on this PC:")
    print(f"    http://localhost:{PORT}")
    print()
    print("  Open from other PCs on the same network:")
    ips = lan_ips()
    if ips:
        for ip in ips:
            print(f"    http://{ip}:{PORT}")
    else:
        print("    (no LAN IP detected — check your network)")
    print("-" * 60)
    print("  Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.server_close()


if __name__ == "__main__":
    main()
