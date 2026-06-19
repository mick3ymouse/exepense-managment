"""
FastAPI backend for the Expense Management App.
Handles file upload/ingestion, expense querying, dashboard stats,
neutral keywords, and reimbursement detection.
"""
import hashlib
import io
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

import pandas as pd
from fastapi import FastAPI, UploadFile, File, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from backend.models import init_db, get_db_connection


# ── Constants ─────────────────────────────────────────────────────

MONTH_NAMES_IT = {
    1: "Gennaio",  2: "Febbraio",  3: "Marzo",     4: "Aprile",
    5: "Maggio",   6: "Giugno",    7: "Luglio",     8: "Agosto",
    9: "Settembre", 10: "Ottobre", 11: "Novembre", 12: "Dicembre",
}

_DATE_FORMATS = ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%d.%m.%Y")


# ── App Setup ─────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Initialise DB on startup."""
    init_db()
    yield

app = FastAPI(lifespan=lifespan)


class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static") or request.url.path == "/":
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

app.add_middleware(NoCacheMiddleware)
app.mount("/static", StaticFiles(directory="frontend"), name="static")


# ══════════════════════════════════════════════════════════════════
#  HELPERS
# ══════════════════════════════════════════════════════════════════

def month_date_range(year: int, month: int) -> tuple[str, str]:
    """Return (start_date, end_date) for a given year/month as SQL range boundaries."""
    start = f"{year}-{month:02d}-01"
    end = f"{year + 1}-01-01" if month == 12 else f"{year}-{month + 1:02d}-01"
    return start, end


def parse_importo(value) -> float:
    """Parse currency value to float, handling Italian (1.200,50) and standard formats."""
    if isinstance(value, (int, float)):
        return float(value)

    s = re.sub(r"[€$£\s]", "", str(value).strip())

    if "." in s and "," in s:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")

    try:
        return float(s)
    except ValueError:
        return 0.0


def generate_hash(data_valuta: str, importo: float, operazione: str, conto_carta: str) -> str:
    """Generate a SHA-256 hash for duplicate detection."""
    raw = f"{data_valuta}|{importo:.2f}|{operazione.strip().lower()}|{conto_carta.strip().lower()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _get_neutral_keywords(conn) -> set[str]:
    """Return a set of lowercase neutral keywords."""
    rows = conn.execute("SELECT keyword FROM neutral_keywords").fetchall()
    return {r["keyword"].lower() for r in rows}


def _get_rimborso_patterns(conn) -> list[str]:
    """Return lowercase operazione patterns for all active rimborso mittenti."""
    rows = conn.execute(
        "SELECT operazione FROM rimborso_mittenti WHERE attivo = 1"
    ).fetchall()
    return [r["operazione"].lower() for r in rows]


def _is_neutral(operazione: str, neutral_kws: set[str], rimborso_patterns: list[str]) -> bool:
    """
    Decide if a transaction should be marked neutral at import time.
    Rimborso mittente matches are NEVER auto-neutral — the user decides via the popup.
    """
    op_lower = operazione.strip().lower()
    if any(pattern in op_lower for pattern in rimborso_patterns):
        return False
    return op_lower in neutral_kws


def _parse_date(raw) -> str | None:
    """Parse a date value from an Excel cell into YYYY-MM-DD, or return None."""
    if pd.isna(raw):
        return None
    if isinstance(raw, datetime):
        return raw.strftime("%Y-%m-%d")
    if isinstance(raw, str):
        for fmt in _DATE_FORMATS:
            try:
                return datetime.strptime(raw.strip(), fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
    return None


def _clean_str(value, fallback: str = "") -> str:
    """Sanitise a cell value: strip whitespace, replace 'nan' with fallback."""
    s = str(value).strip()
    return fallback if s == "nan" else s


def _parse_expense_body(body: dict) -> tuple:
    """
    Validate and parse expense fields from a JSON request body.
    Returns (data_valuta, operazione, categoria, conto_carta, importo, error_response).
    error_response is None on success.
    """
    data_valuta = body.get("data_valuta", "").strip()
    operazione = body.get("operazione", "").strip()
    categoria = body.get("categoria", "").strip()
    conto_carta = body.get("conto_carta", "").strip()
    importo_raw = body.get("importo", 0)

    if not data_valuta or not operazione:
        return None, None, None, None, None, JSONResponse(
            status_code=400,
            content={"error": "Data e Operazione sono obbligatori."},
        )

    try:
        datetime.strptime(data_valuta, "%Y-%m-%d")
    except ValueError:
        return None, None, None, None, None, JSONResponse(
            status_code=400,
            content={"error": "Formato data non valido. Usa YYYY-MM-DD."},
        )

    return data_valuta, operazione, categoria, conto_carta, parse_importo(importo_raw), None


# ══════════════════════════════════════════════════════════════════
#  EXCEL PROCESSING
# ══════════════════════════════════════════════════════════════════

def _check_fuzzy_duplicate(conn, data_valuta: str, importo: float, operazione: str) -> bool:
    """Return True if a fuzzy duplicate exists (same amount + operation within ±2 days)."""
    try:
        target = datetime.strptime(data_valuta, "%Y-%m-%d")
    except ValueError:
        return False

    lo = (target - timedelta(days=2)).strftime("%Y-%m-%d")
    hi = (target + timedelta(days=2)).strftime("%Y-%m-%d")

    count = conn.execute("""
        SELECT COUNT(*) FROM expenses
        WHERE importo = ?
          AND LOWER(TRIM(operazione)) = ?
          AND data_valuta BETWEEN ? AND ?
    """, (importo, operazione.strip().lower(), lo, hi)).fetchone()[0]
    return count > 0


def _try_replace_pending(conn, data_valuta: str, importo: float,
                         operazione: str, conto_carta: str, categoria: str,
                         valuta: str, hash_id: str, is_neutral_flag: int) -> bool:
    """
    Try to replace a matching pending POS transaction (FIFO by oldest date).
    Returns True if a pending row was replaced.
    """
    target = datetime.strptime(data_valuta, "%Y-%m-%d")
    lo = (target - timedelta(days=7)).strftime("%Y-%m-%d")
    hi = (target + timedelta(days=7)).strftime("%Y-%m-%d")

    pending = conn.execute("""
        SELECT id FROM expenses
        WHERE is_pending = 1 AND importo = ? AND data_valuta BETWEEN ? AND ?
        ORDER BY data_valuta ASC
        LIMIT 1
    """, (importo, lo, hi)).fetchone()

    if not pending:
        return False

    conn.execute("""
        UPDATE expenses
        SET data_valuta = ?, operazione = ?, conto_carta = ?, categoria = ?,
            valuta = ?, importo = ?, hash_id = ?, is_neutral = ?, is_pending = 0
        WHERE id = ?
    """, (data_valuta, operazione, conto_carta, categoria,
          valuta, importo, hash_id, is_neutral_flag, pending["id"]))
    return True


def _delete_matching_pending(conn, data_valuta: str, importo: float, stats: dict) -> None:
    """
    Delete a pending POS entry that matches a finalised row already in the DB.
    Called when the finalised row is a hash duplicate (already imported) but
    its pending counterpart was never cleaned up.
    """
    target = datetime.strptime(data_valuta, "%Y-%m-%d")
    lo = (target - timedelta(days=7)).strftime("%Y-%m-%d")
    hi = (target + timedelta(days=7)).strftime("%Y-%m-%d")

    pending = conn.execute("""
        SELECT id FROM expenses
        WHERE is_pending = 1 AND importo = ? AND data_valuta BETWEEN ? AND ?
        ORDER BY data_valuta ASC
        LIMIT 1
    """, (importo, lo, hi)).fetchone()

    if pending:
        conn.execute("DELETE FROM expenses WHERE id = ?", (pending["id"],))
        stats["replaced"] += 1


def process_excel(file_bytes: bytes) -> dict:
    """
    Process an Excel file and insert new expenses into the database.
    Returns stats: { new, duplicates, replaced, fuzzy_matches, errors }.
    """
    df = pd.read_excel(io.BytesIO(file_bytes), header=18, engine="openpyxl")
    df.columns = df.columns.str.strip()
    df = df.dropna(how="all")

    stats = {"new": 0, "duplicates": 0, "replaced": 0, "fuzzy_matches": [], "errors": 0}
    conn = get_db_connection()

    try:
        neutral_kws = _get_neutral_keywords(conn)
        rimborso_patterns = _get_rimborso_patterns(conn)

        for _, row in df.iterrows():
            try:
                _ingest_row(conn, row, neutral_kws, rimborso_patterns, stats)
            except Exception:
                stats["errors"] += 1

        conn.commit()
    finally:
        conn.close()

    return stats


def _ingest_row(conn, row, neutral_kws: set, rimborso_patterns: list, stats: dict) -> None:
    """Process a single DataFrame row: parse, check duplicates, insert or replace."""
    data_valuta = _parse_date(row.get("Data", None))
    if data_valuta is None:
        stats["errors"] += 1
        return

    operazione = _clean_str(row.get("Operazione", ""))
    if not operazione:
        return

    conto_carta = _clean_str(row.get("Conto o carta", ""))
    categoria = _clean_str(row.get("Categoria", ""))
    valuta = _clean_str(row.get("Valuta", "EUR"), fallback="EUR")
    importo = parse_importo(row.get("Importo", 0))

    op_lower = operazione.lower()
    is_pending = 1 if ("pagamento" in op_lower and "pos" in op_lower) else 0
    hash_id = generate_hash(data_valuta, importo, operazione, conto_carta)

    # 1) Exact hash duplicate
    is_dup = conn.execute("SELECT 1 FROM expenses WHERE hash_id = ?", (hash_id,)).fetchone()

    if is_dup:
        # Even though the finalised row already exists, a matching pending POS
        # entry may still be sitting in the DB from an earlier import.  Clean it up.
        if is_pending == 0:
            _delete_matching_pending(conn, data_valuta, importo, stats)
        stats["duplicates"] += 1
        return

    is_neutral_flag = 1 if _is_neutral(operazione, neutral_kws, rimborso_patterns) else 0

    # 2) Finalised entry → try to replace a matching pending POS entry (FIFO)
    if is_pending == 0 and _try_replace_pending(
        conn, data_valuta, importo, operazione, conto_carta,
        categoria, valuta, hash_id, is_neutral_flag
    ):
        stats["replaced"] += 1
        return

    # 3) Fuzzy duplicate check
    if _check_fuzzy_duplicate(conn, data_valuta, importo, operazione):
        stats["fuzzy_matches"].append({
            "data": data_valuta, "operazione": operazione, "importo": importo,
        })
        stats["duplicates"] += 1
        return

    # 4) Insert as new expense
    conn.execute("""
        INSERT INTO expenses
            (data_valuta, operazione, conto_carta, categoria,
             valuta, importo, hash_id, is_neutral, is_pending)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (data_valuta, operazione, conto_carta, categoria,
          valuta, importo, hash_id, is_neutral_flag, is_pending))
    stats["new"] += 1


# ══════════════════════════════════════════════════════════════════
#  API — ROOT & UPLOAD
# ══════════════════════════════════════════════════════════════════

@app.get("/", response_class=HTMLResponse)
async def read_root():
    """Serve the main HTML page."""
    with open("frontend/index.html", "r", encoding="utf-8") as f:
        return f.read()


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload an Excel file, process it, and return ingestion stats."""
    if not file.filename.endswith(".xlsx"):
        return JSONResponse(status_code=400, content={"error": "Solo file .xlsx sono accettati."})

    try:
        return process_excel(await file.read())
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Errore durante il processamento: {e}"})


# ══════════════════════════════════════════════════════════════════
#  API — EXPENSES CRUD
# ══════════════════════════════════════════════════════════════════

@app.get("/expenses")
async def get_expenses(
    search_text: str = Query(default=None),
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
):
    """
    Get all expenses, optionally filtered, grouped by Year > Month.
    Returns: { "2026": { "Febbraio": [...], "Gennaio": [...] }, ... }
    """
    query = "SELECT * FROM expenses WHERE 1=1"
    params: list = []

    if search_text:
        like = f"%{search_text.lower()}%"
        query += " AND (LOWER(operazione) LIKE ? OR LOWER(categoria) LIKE ? OR LOWER(conto_carta) LIKE ?)"
        params.extend([like, like, like])
    if start_date:
        query += " AND data_valuta >= ?"
        params.append(start_date)
    if end_date:
        query += " AND data_valuta <= ?"
        params.append(end_date)
    query += " ORDER BY data_valuta DESC"

    conn = get_db_connection()
    try:
        rows = conn.execute(query, params).fetchall()
    finally:
        conn.close()

    # Group by year (desc) then by month (desc)
    month_order = {v: k for k, v in MONTH_NAMES_IT.items()}
    grouped: dict[str, dict[str, list]] = {}

    for row in rows:
        d = dict(row)
        try:
            dt = datetime.strptime(d["data_valuta"], "%Y-%m-%d")
            year, month = str(dt.year), MONTH_NAMES_IT.get(dt.month, str(dt.month))
        except ValueError:
            year, month = "Sconosciuto", "Sconosciuto"

        grouped.setdefault(year, {}).setdefault(month, []).append(d)

    # Sort years descending, months descending within each year
    return {
        y: {
            m: grouped[y][m]
            for m in sorted(grouped[y], key=lambda m: month_order.get(m, 0), reverse=True)
        }
        for y in sorted(grouped, reverse=True)
    }


@app.post("/expenses")
async def create_expense(request: Request):
    """Create a manual expense entry."""
    body = await request.json()
    data_valuta, operazione, categoria, conto_carta, importo, err = _parse_expense_body(body)
    if err:
        return err

    hash_id = generate_hash(data_valuta, importo, operazione, conto_carta)

    conn = get_db_connection()
    try:
        if conn.execute("SELECT 1 FROM expenses WHERE hash_id = ?", (hash_id,)).fetchone():
            return JSONResponse(status_code=409, content={"error": "Spesa duplicata già presente."})

        neutral_kws = _get_neutral_keywords(conn)
        rimborso_patterns = _get_rimborso_patterns(conn)
        is_neutral_flag = 1 if _is_neutral(operazione, neutral_kws, rimborso_patterns) else 0

        conn.execute("""
            INSERT INTO expenses
                (data_valuta, operazione, conto_carta, categoria, valuta, importo, hash_id, is_neutral)
            VALUES (?, ?, ?, ?, 'EUR', ?, ?, ?)
        """, (data_valuta, operazione, conto_carta, categoria, importo, hash_id, is_neutral_flag))
        conn.commit()

        row = conn.execute("SELECT * FROM expenses WHERE hash_id = ?", (hash_id,)).fetchone()
        return dict(row)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Errore durante il salvataggio: {e}"})
    finally:
        conn.close()


@app.patch("/expenses/{expense_id}")
async def update_expense(expense_id: int, request: Request):
    """Update an existing expense entry."""
    body = await request.json()
    data_valuta, operazione, categoria, conto_carta, importo, err = _parse_expense_body(body)
    if err:
        return err

    new_hash = generate_hash(data_valuta, importo, operazione, conto_carta)

    conn = get_db_connection()
    try:
        existing = conn.execute("SELECT is_neutral, is_ignored_rimborso FROM expenses WHERE id = ?", (expense_id,)).fetchone()
        if not existing:
            return JSONResponse(status_code=404, content={"error": "Spesa non trovata."})

        # Hash collision with a DIFFERENT record?
        collision = conn.execute(
            "SELECT 1 FROM expenses WHERE hash_id = ? AND id != ?", (new_hash, expense_id)
        ).fetchone()
        if collision:
            return JSONResponse(status_code=409, content={"error": "Una spesa identica è già presente."})

        # Preserve is_neutral if the entry was explicitly confirmed as rimborso
        # or explicitly ignored. Only re-evaluate for "normal" entries.
        if existing["is_neutral"] == 1 or existing["is_ignored_rimborso"] == 1:
            is_neutral_flag = existing["is_neutral"]
        else:
            neutral_kws = _get_neutral_keywords(conn)
            rimborso_patterns = _get_rimborso_patterns(conn)
            is_neutral_flag = 1 if _is_neutral(operazione, neutral_kws, rimborso_patterns) else 0

        conn.execute("""
            UPDATE expenses
            SET data_valuta = ?, operazione = ?, conto_carta = ?, categoria = ?,
                importo = ?, hash_id = ?, is_neutral = ?
            WHERE id = ?
        """, (data_valuta, operazione, conto_carta, categoria, importo, new_hash, is_neutral_flag, expense_id))
        conn.commit()

        row = conn.execute("SELECT * FROM expenses WHERE id = ?", (expense_id,)).fetchone()
        return dict(row)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Errore durante l'aggiornamento: {e}"})
    finally:
        conn.close()


@app.patch("/expenses/{expense_id}/toggle")
async def toggle_expense(expense_id: int):
    """Toggle the is_excluded flag for a given expense."""
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT is_excluded FROM expenses WHERE id = ?", (expense_id,)).fetchone()
        if not row:
            return JSONResponse(status_code=404, content={"error": "Spesa non trovata."})

        new_value = 0 if row["is_excluded"] else 1
        conn.execute("UPDATE expenses SET is_excluded = ? WHERE id = ?", (new_value, expense_id))
        conn.commit()
        return {"id": expense_id, "is_excluded": bool(new_value)}
    finally:
        conn.close()


@app.delete("/expenses/bulk-delete")
async def bulk_delete_expenses(request: Request):
    """Delete all expenses for given month/year combos and reset monthly_status."""
    body = await request.json()
    periods = body.get("periods", [])
    if not periods:
        return JSONResponse(status_code=400, content={"error": "Nessun periodo specificato."})

    conn = get_db_connection()
    try:
        total_deleted = 0
        for p in periods:
            m, y = int(p["month"]), int(p["year"])
            sd, ed = month_date_range(y, m)
            cur = conn.execute("DELETE FROM expenses WHERE data_valuta >= ? AND data_valuta < ?", (sd, ed))
            total_deleted += cur.rowcount
            conn.execute("DELETE FROM monthly_status WHERE month = ? AND year = ?", (m, y))
        conn.commit()
        return {"deleted": total_deleted}
    finally:
        conn.close()


@app.delete("/expenses/{expense_id}")
async def delete_expense(expense_id: int):
    """Delete a single expense by ID."""
    conn = get_db_connection()
    try:
        if not conn.execute("SELECT 1 FROM expenses WHERE id = ?", (expense_id,)).fetchone():
            return JSONResponse(status_code=404, content={"error": "Spesa non trovata."})

        conn.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
        conn.commit()
        return {"deleted": expense_id}
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════
#  API — DASHBOARD & PERIODS
# ══════════════════════════════════════════════════════════════════

@app.get("/available-periods")
async def get_available_periods():
    """Return all year/month combinations that have data, plus the latest period."""
    conn = get_db_connection()
    try:
        rows = conn.execute("""
            SELECT DISTINCT
                CAST(strftime('%Y', data_valuta) AS INTEGER) AS year,
                CAST(strftime('%m', data_valuta) AS INTEGER) AS month
            FROM expenses
            ORDER BY year DESC, month DESC
        """).fetchall()
    finally:
        conn.close()

    if not rows:
        return {"periods": [], "latest_year": None, "latest_month": None}

    years_set: set[int] = set()
    periods = []
    for r in rows:
        years_set.add(r["year"])
        periods.append({
            "year": r["year"],
            "month": r["month"],
            "month_name": MONTH_NAMES_IT.get(r["month"], str(r["month"])),
        })

    return {
        "periods": periods,
        "years": sorted(years_set, reverse=True),
        "latest_year": rows[0]["year"],
        "latest_month": rows[0]["month"],
    }


@app.get("/dashboard-stats")
async def get_dashboard_stats(year: int = Query(...), month: int = Query(...)):
    """Dashboard statistics for a given month/year."""
    sd, ed = month_date_range(year, month)

    conn = get_db_connection()
    try:
        totals = conn.execute("""
            SELECT
                COALESCE(SUM(CASE WHEN importo > 0 THEN importo ELSE 0 END), 0) AS entrate,
                COALESCE(SUM(CASE WHEN importo < 0 THEN importo ELSE 0 END), 0) AS uscite,
                COALESCE(SUM(importo), 0) AS saldo,
                COUNT(*) AS count
            FROM expenses
            WHERE data_valuta >= ? AND data_valuta < ?
              AND is_excluded = 0
              AND (is_neutral = 0 OR is_ignored_rimborso = 1)
        """, (sd, ed)).fetchone()

        top_categories = conn.execute("""
            SELECT categoria, SUM(ABS(importo)) AS totale
            FROM expenses
            WHERE data_valuta >= ? AND data_valuta < ?
              AND is_excluded = 0 AND is_neutral = 0
              AND importo < 0
              AND categoria != '' AND categoria IS NOT NULL
            GROUP BY categoria
            ORDER BY totale DESC
            LIMIT 3
        """, (sd, ed)).fetchall()
    finally:
        conn.close()

    return {
        "year": year,
        "month": month,
        "month_name": MONTH_NAMES_IT.get(month, str(month)),
        "entrate": round(totals["entrate"], 2),
        "uscite": round(abs(totals["uscite"]), 2),
        "saldo": round(totals["saldo"], 2),
        "count": totals["count"],
        "top_categories": [
            {"categoria": r["categoria"], "totale": round(r["totale"], 2)}
            for r in top_categories
        ],
    }


# ══════════════════════════════════════════════════════════════════
#  API — MONTHLY REIMBURSEMENT STATUS
# ══════════════════════════════════════════════════════════════════

@app.get("/monthly-status")
async def get_monthly_status():
    """Return paid/unpaid status for every month."""
    conn = get_db_connection()
    try:
        rows = conn.execute("SELECT month, year, is_paid FROM monthly_status").fetchall()
    finally:
        conn.close()

    return {f"{r['year']}-{r['month']:02d}": bool(r["is_paid"]) for r in rows}


@app.post("/monthly-status")
async def set_monthly_status(request: Request):
    """Upsert is_paid flag for a given month/year."""
    body = await request.json()
    month, year = int(body["month"]), int(body["year"])
    is_paid = 1 if body.get("is_paid") else 0

    conn = get_db_connection()
    try:
        conn.execute("""
            INSERT INTO monthly_status (month, year, is_paid)
            VALUES (?, ?, ?)
            ON CONFLICT(month, year) DO UPDATE SET is_paid = excluded.is_paid
        """, (month, year, is_paid))
        conn.commit()
    finally:
        conn.close()

    return {"month": month, "year": year, "is_paid": bool(is_paid)}


# ══════════════════════════════════════════════════════════════════
#  API — NEUTRAL KEYWORDS
# ══════════════════════════════════════════════════════════════════

@app.get("/neutral-keywords")
async def get_keywords():
    """Return all neutral keywords, flagging those matching an active rimborso mittente."""
    conn = get_db_connection()
    try:
        rows = conn.execute("""
            SELECT nk.id, nk.keyword,
                   CASE WHEN rm.id IS NOT NULL THEN 1 ELSE 0 END AS is_rimborso
            FROM neutral_keywords nk
            LEFT JOIN rimborso_mittenti rm
                   ON LOWER(nk.keyword) = LOWER(rm.operazione) AND rm.attivo = 1
            ORDER BY nk.keyword
        """).fetchall()
    finally:
        conn.close()

    return [{"id": r["id"], "keyword": r["keyword"], "is_rimborso": bool(r["is_rimborso"])} for r in rows]


@app.post("/neutral-keywords")
async def add_keyword(request: Request):
    """Add a neutral keyword and re-flag matching existing expenses."""
    body = await request.json()
    keyword = body.get("keyword", "").strip()
    if not keyword:
        return JSONResponse(status_code=400, content={"error": "Keyword vuota."})

    conn = get_db_connection()
    try:
        conn.execute("INSERT INTO neutral_keywords (keyword) VALUES (?)", (keyword,))
        conn.execute(
            "UPDATE expenses SET is_neutral = 1 WHERE LOWER(TRIM(operazione)) = ?",
            (keyword.lower(),),
        )
        conn.commit()

        row = conn.execute(
            "SELECT id, keyword FROM neutral_keywords WHERE keyword = ?", (keyword,)
        ).fetchone()
        return {"id": row["id"], "keyword": row["keyword"]}
    except Exception:
        return JSONResponse(status_code=409, content={"error": "Keyword già presente."})
    finally:
        conn.close()


@app.delete("/neutral-keywords/{kw_id}")
async def delete_keyword(kw_id: int):
    """Remove a neutral keyword and un-flag matching expenses."""
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT keyword FROM neutral_keywords WHERE id = ?", (kw_id,)).fetchone()
        if not row:
            return JSONResponse(status_code=404, content={"error": "Keyword non trovata."})

        conn.execute("DELETE FROM neutral_keywords WHERE id = ?", (kw_id,))
        conn.execute(
            "UPDATE expenses SET is_neutral = 0 WHERE LOWER(TRIM(operazione)) = ?",
            (row["keyword"].lower(),),
        )
        conn.commit()
        return {"deleted": kw_id}
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════
#  API — RIMBORSO MITTENTI
# ══════════════════════════════════════════════════════════════════

@app.get("/rimborso-mittenti")
async def get_rimborso_mittenti():
    conn = get_db_connection()
    try:
        rows = conn.execute(
            "SELECT id, operazione, keyword_id, tolleranza, attivo "
            "FROM rimborso_mittenti ORDER BY operazione"
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


@app.post("/rimborso-mittenti")
async def add_rimborso_mittente(request: Request):
    """Add a new mittente for reimbursement detection."""
    body = await request.json()
    operazione = body.get("operazione", "").strip()
    tolleranza = float(body.get("tolleranza", 5.0))
    attivo = 1 if body.get("attivo", True) else 0

    if not operazione:
        return JSONResponse(status_code=400, content={"error": "Operazione obbligatoria."})

    conn = get_db_connection()
    try:
        conn.execute(
            "INSERT INTO rimborso_mittenti (operazione, tolleranza, attivo) VALUES (?, ?, ?)",
            (operazione, tolleranza, attivo),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM rimborso_mittenti WHERE operazione = ?", (operazione,)).fetchone()
        return dict(row)
    except Exception as e:
        return JSONResponse(status_code=409, content={"error": f"Mittente già presente: {e}"})
    finally:
        conn.close()


@app.patch("/rimborso-mittenti/{mid}")
async def update_rimborso_mittente(mid: int, request: Request):
    body = await request.json()
    conn = get_db_connection()
    try:
        if not conn.execute("SELECT 1 FROM rimborso_mittenti WHERE id = ?", (mid,)).fetchone():
            return JSONResponse(status_code=404, content={"error": "Mittente non trovato."})

        if "tolleranza" in body:
            conn.execute("UPDATE rimborso_mittenti SET tolleranza = ? WHERE id = ?", (float(body["tolleranza"]), mid))
        if "attivo" in body:
            conn.execute("UPDATE rimborso_mittenti SET attivo = ? WHERE id = ?", (1 if body["attivo"] else 0, mid))
        conn.commit()

        row = conn.execute("SELECT * FROM rimborso_mittenti WHERE id = ?", (mid,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@app.delete("/rimborso-mittenti/{mid}")
async def delete_rimborso_mittente(mid: int):
    """Delete a mittente from reimbursement detection."""
    conn = get_db_connection()
    try:
        if not conn.execute("SELECT 1 FROM rimborso_mittenti WHERE id = ?", (mid,)).fetchone():
            return JSONResponse(status_code=404, content={"error": "Mittente non trovato."})

        conn.execute("DELETE FROM rimborso_mittenti WHERE id = ?", (mid,))
        conn.commit()
        return {"deleted": mid}
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════
#  API — RIMBORSO DETECTION & ACTIONS
# ══════════════════════════════════════════════════════════════════

def _find_unpaid_months(conn) -> list[dict]:
    """Return a list of unpaid months with their reimbursable expense totals."""
    paid_keys = {
        (r["year"], r["month"])
        for r in conn.execute("SELECT year, month FROM monthly_status WHERE is_paid = 1").fetchall()
    }

    month_rows = conn.execute("""
        SELECT DISTINCT
            CAST(strftime('%Y', data_valuta) AS INTEGER) AS year,
            CAST(strftime('%m', data_valuta) AS INTEGER) AS month
        FROM expenses WHERE is_neutral = 0
        ORDER BY year, month
    """).fetchall()

    unpaid = []
    for r in month_rows:
        y, m = r["year"], r["month"]
        if (y, m) in paid_keys:
            continue

        sd, ed = month_date_range(y, m)
        total = conn.execute("""
            SELECT COALESCE(SUM(importo), 0) AS t FROM expenses
            WHERE data_valuta >= ? AND data_valuta < ?
              AND is_excluded = 0 AND is_neutral = 0 AND is_ignored_rimborso = 0
        """, (sd, ed)).fetchone()["t"]

        if abs(total) > 0.01:
            unpaid.append({
                "year": y, "month": m,
                "month_name": MONTH_NAMES_IT.get(m, str(m)),
                "amount": round(total, 2),
            })

    return unpaid


def _match_months_to_amount(tx_amount: float, tx_date: str,
                            unpaid: list[dict], tolleranza: float) -> dict | None:
    """
    Find the best contiguous window of unpaid months whose total matches tx_amount.
    Only months whose end-date is before tx_date are eligible.
    Returns the best match dict, or None.
    """
    # Filter: only months that end before the transaction date
    eligible = []
    for m in unpaid:
        _, month_end = month_date_range(m["year"], m["month"])
        if month_end <= tx_date:
            eligible.append(m)

    if not eligible:
        return None

    eligible.sort(key=lambda m: (m["year"], m["month"]))

    best = None
    for start in range(len(eligible)):
        for end in range(start, min(start + 4, len(eligible))):
            combo = eligible[start:end + 1]
            total = sum(m["amount"] for m in combo)
            diff = abs(abs(total) - tx_amount)
            if diff <= tolleranza and (best is None or diff < best["diff"]):
                best = {
                    "months": list(combo),
                    "months_total": round(total, 2),
                    "diff": round(diff, 2),
                }

    return best


@app.get("/detect-rimborso")
async def detect_rimborso():
    """Find reimbursement transactions matching active mittenti against unpaid months."""
    conn = get_db_connection()
    try:
        mittenti = conn.execute(
            "SELECT operazione, tolleranza FROM rimborso_mittenti WHERE attivo = 1"
        ).fetchall()
        if not mittenti:
            return {"candidates": []}

        unpaid = _find_unpaid_months(conn)
        if not unpaid:
            return {"candidates": []}

        candidates = []
        seen_ids: set[int] = set()

        for mit in mittenti:
            pattern, tol = mit["operazione"], mit["tolleranza"]
            txs = conn.execute("""
                SELECT id, data_valuta, operazione, importo FROM expenses
                WHERE LOWER(TRIM(operazione)) LIKE ? AND importo > 0
                  AND is_ignored_rimborso = 0 AND is_neutral = 0
                ORDER BY data_valuta DESC
            """, (f"%{pattern.lower()}%",)).fetchall()

            for tx in txs:
                if tx["id"] in seen_ids:
                    continue
                seen_ids.add(tx["id"])

                match = _match_months_to_amount(tx["importo"], tx["data_valuta"], unpaid, tol)
                candidates.append({
                    "transaction": dict(tx),
                    "months": match["months"] if match else [],
                    "months_total": match["months_total"] if match else 0.0,
                    "diff": match["diff"] if match else 0.0,
                })

        return {"candidates": candidates}
    finally:
        conn.close()


@app.put("/expenses/{expense_id}/ignore-rimborso")
async def toggle_ignore_rimborso(expense_id: int):
    """Toggle is_ignored_rimborso flag so the transaction won't trigger the popup."""
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT is_ignored_rimborso FROM expenses WHERE id = ?", (expense_id,)).fetchone()
        if not row:
            return JSONResponse(status_code=404, content={"error": "Spesa non trovata."})

        new_val = 0 if row["is_ignored_rimborso"] else 1
        conn.execute("UPDATE expenses SET is_ignored_rimborso = ? WHERE id = ?", (new_val, expense_id))
        conn.commit()
        return {"ok": True, "is_ignored_rimborso": new_val}
    finally:
        conn.close()


@app.put("/expenses/{expense_id}/confirm-rimborso")
async def confirm_rimborso(expense_id: int):
    """Mark a transaction as a confirmed reimbursement (is_neutral = 1)."""
    conn = get_db_connection()
    try:
        if not conn.execute("SELECT 1 FROM expenses WHERE id = ?", (expense_id,)).fetchone():
            return JSONResponse(status_code=404, content={"error": "Spesa non trovata."})

        conn.execute("UPDATE expenses SET is_neutral = 1 WHERE id = ?", (expense_id,))
        conn.commit()
        return {"ok": True, "is_neutral": 1}
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════
#  ENTRYPOINT
# ══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
