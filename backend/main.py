"""
FastAPI backend for the Expense Management App.
Handles file upload/ingestion, expense querying, and toggle exclusion.
"""
import hashlib
import io
import re
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

import pandas as pd
from fastapi import FastAPI, UploadFile, File, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from backend.models import init_db, get_db_connection

# ── Italian month names for grouping ──────────────────────────────
MONTH_NAMES_IT = {
    1: "Gennaio", 2: "Febbraio", 3: "Marzo", 4: "Aprile",
    5: "Maggio", 6: "Giugno", 7: "Luglio", 8: "Agosto",
    9: "Settembre", 10: "Ottobre", 11: "Novembre", 12: "Dicembre"
}


# ── App Lifespan ──────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize DB on startup."""
    init_db()
    yield

app = FastAPI(lifespan=lifespan)


# ── Middleware: No-Cache for Dev ──────────────────────────────────
class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static") or request.url.path == "/":
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

app.add_middleware(NoCacheMiddleware)


# ── Static files ──────────────────────────────────────────────────
app.mount("/static", StaticFiles(directory="frontend"), name="static")


# ── Helpers ───────────────────────────────────────────────────────

def get_neutral_keywords(conn) -> set:
    """Return set of lowercase neutral keywords from the DB."""
    rows = conn.execute("SELECT keyword FROM neutral_keywords").fetchall()
    return {r['keyword'].lower() for r in rows}


def check_neutral(operazione: str, neutral_kws: set) -> bool:
    """Check if operazione matches any neutral keyword (case-insensitive full match)."""
    return operazione.strip().lower() in neutral_kws


def parse_importo(value) -> float:
    """
    Parse currency string to float, handling both Italian and standard formats.

    Italian format: uses '.' as thousands separator and ',' as decimal separator
      e.g. "1.200,50" → 1200.50, "-45,00" → -45.0, "10,3" → 10.3

    Standard format: uses '.' as decimal separator (already a float or "10.3")
      e.g. 10.3 → 10.3, "-45.00" → -45.0

    Key rule: if both '.' and ',' are present → Italian format (remove dots, comma→dot)
              if only ',' → Italian decimal (replace comma with dot)
              if only '.' or neither → standard format (leave as-is)
    """
    if isinstance(value, (int, float)):
        return float(value)

    s = str(value).strip()
    # Remove currency symbols and whitespace
    s = re.sub(r'[€$£\s]', '', s)

    has_dot = '.' in s
    has_comma = ',' in s

    if has_dot and has_comma:
        # Italian format: "1.200,50" — dots are thousands separators
        # The comma must be the decimal separator (Italian convention)
        s = s.replace('.', '').replace(',', '.')
    elif has_comma and not has_dot:
        # Only comma: treat as Italian decimal separator "10,3" → "10.3"
        s = s.replace(',', '.')
    # else: only dot or no separator → standard float format, leave as-is

    try:
        return float(s)
    except ValueError:
        return 0.0


def generate_hash(data_valuta: str, importo: float, operazione: str, conto_carta: str) -> str:
    """Generate a unique hash for duplicate detection."""
    raw = f"{data_valuta}|{importo:.2f}|{operazione.strip().lower()}|{conto_carta.strip().lower()}"
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def check_fuzzy_duplicate(conn, data_valuta: str, importo: float, operazione: str) -> bool:
    """
    Fuzzy duplicate check: same importo + operazione within ±2 days.
    Returns True if a fuzzy match is found.
    """
    try:
        target_date = datetime.strptime(data_valuta, '%Y-%m-%d')
    except ValueError:
        return False

    date_minus = (target_date - timedelta(days=2)).strftime('%Y-%m-%d')
    date_plus = (target_date + timedelta(days=2)).strftime('%Y-%m-%d')

    cursor = conn.execute("""
        SELECT COUNT(*) FROM expenses
        WHERE importo = ?
          AND LOWER(TRIM(operazione)) = ?
          AND data_valuta BETWEEN ? AND ?
    """, (importo, operazione.strip().lower(), date_minus, date_plus))

    count = cursor.fetchone()[0]
    return count > 0


def process_excel(file_bytes: bytes) -> dict:
    """
    Process an Excel file and insert new expenses into the database.
    Returns stats: { new, duplicates, fuzzy_matches, errors }.
    """
    df = pd.read_excel(
        io.BytesIO(file_bytes),
        header=18,
        engine='openpyxl'
    )

    df.columns = df.columns.str.strip()
    df = df.dropna(how='all')

    stats = {"new": 0, "duplicates": 0, "fuzzy_matches": [], "errors": 0}
    conn = get_db_connection()
    neutral_kws = get_neutral_keywords(conn)

    try:
        for _, row in df.iterrows():
            try:
                data_raw = row.get('Data', None)
                if pd.isna(data_raw):
                    continue

                if isinstance(data_raw, datetime):
                    data_valuta = data_raw.strftime('%Y-%m-%d')
                elif isinstance(data_raw, str):
                    for fmt in ('%d/%m/%Y', '%d-%m-%Y', '%Y-%m-%d', '%d.%m.%Y'):
                        try:
                            data_valuta = datetime.strptime(data_raw.strip(), fmt).strftime('%Y-%m-%d')
                            break
                        except ValueError:
                            continue
                    else:
                        stats["errors"] += 1
                        continue
                else:
                    stats["errors"] += 1
                    continue

                operazione = str(row.get('Operazione', '')).strip()
                conto_carta = str(row.get('Conto o carta', '')).strip()
                categoria = str(row.get('Categoria', '')).strip()
                valuta = str(row.get('Valuta', 'EUR')).strip()
                importo = parse_importo(row.get('Importo', 0))

                if not operazione or operazione == 'nan':
                    continue

                if conto_carta == 'nan': conto_carta = ''
                if categoria == 'nan': categoria = ''
                if valuta == 'nan': valuta = 'EUR'

                hash_id = generate_hash(data_valuta, importo, operazione, conto_carta)

                existing = conn.execute(
                    "SELECT id FROM expenses WHERE hash_id = ?", (hash_id,)
                ).fetchone()

                if existing:
                    stats["duplicates"] += 1
                    continue

                if check_fuzzy_duplicate(conn, data_valuta, importo, operazione):
                    stats["fuzzy_matches"].append({
                        "data": data_valuta,
                        "operazione": operazione,
                        "importo": importo
                    })
                    stats["duplicates"] += 1
                    continue

                is_neutral = 1 if check_neutral(operazione, neutral_kws) else 0

                conn.execute("""
                    INSERT INTO expenses
                        (data_valuta, operazione, conto_carta, categoria, valuta, importo, hash_id, is_neutral)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (data_valuta, operazione, conto_carta, categoria, valuta, importo, hash_id, is_neutral))

                stats["new"] += 1

            except Exception:
                stats["errors"] += 1
                continue

        conn.commit()
    finally:
        conn.close()

    return stats


# ── API Endpoints ─────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def read_root():
    """Serve the main HTML page."""
    with open("frontend/index.html", "r", encoding="utf-8") as f:
        return f.read()


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload an Excel file, process it, and return ingestion stats."""
    if not file.filename.endswith('.xlsx'):
        return JSONResponse(
            status_code=400,
            content={"error": "Solo file .xlsx sono accettati."}
        )

    file_bytes = await file.read()
    try:
        stats = process_excel(file_bytes)
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Errore durante il processamento: {str(e)}"}
        )

    return stats


@app.get("/expenses")
async def get_expenses(
    search_text: str = Query(default=None),
    start_date: str = Query(default=None),
    end_date: str = Query(default=None)
):
    """
    Get all expenses, optionally filtered, grouped by Year > Month.
    Returns: { "2026": { "Febbraio": [...], "Gennaio": [...] }, ... }
    """
    conn = get_db_connection()

    query = "SELECT * FROM expenses WHERE 1=1"
    params = []

    if search_text:
        query += " AND (LOWER(operazione) LIKE ? OR LOWER(categoria) LIKE ? OR LOWER(conto_carta) LIKE ?)"
        like_param = f"%{search_text.lower()}%"
        params.extend([like_param, like_param, like_param])

    if start_date:
        query += " AND data_valuta >= ?"
        params.append(start_date)

    if end_date:
        query += " AND data_valuta <= ?"
        params.append(end_date)

    query += " ORDER BY data_valuta DESC"

    rows = conn.execute(query, params).fetchall()
    conn.close()

    grouped = defaultdict(lambda: defaultdict(list))
    for row in rows:
        row_dict = dict(row)
        date_str = row_dict['data_valuta']
        try:
            dt = datetime.strptime(date_str, '%Y-%m-%d')
            year = str(dt.year)
            month = MONTH_NAMES_IT.get(dt.month, str(dt.month))
        except ValueError:
            year = "Sconosciuto"
            month = "Sconosciuto"

        grouped[year][month].append(row_dict)

    result = {}
    for year in sorted(grouped.keys(), reverse=True):
        months_data = grouped[year]
        month_order = {v: k for k, v in MONTH_NAMES_IT.items()}
        sorted_months = sorted(
            months_data.keys(),
            key=lambda m: month_order.get(m, 0),
            reverse=True
        )
        result[year] = {}
        for month in sorted_months:
            result[year][month] = months_data[month]

    return result


@app.patch("/expenses/{expense_id}/toggle")
async def toggle_expense(expense_id: int):
    """Toggle the is_excluded flag for a given expense."""
    conn = get_db_connection()

    row = conn.execute("SELECT is_excluded FROM expenses WHERE id = ?", (expense_id,)).fetchone()
    if not row:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Spesa non trovata."})

    new_value = 0 if row['is_excluded'] else 1
    conn.execute("UPDATE expenses SET is_excluded = ? WHERE id = ?", (new_value, expense_id))
    conn.commit()
    conn.close()

    return {"id": expense_id, "is_excluded": bool(new_value)}


@app.patch("/expenses/{expense_id}")
async def update_expense(expense_id: int, request: Request):
    """
    Update an existing expense entry.
    Expects JSON: { data_valuta, operazione, categoria, conto_carta, importo }
    """
    body = await request.json()

    data_valuta = body.get("data_valuta", "").strip()
    operazione = body.get("operazione", "").strip()
    categoria = body.get("categoria", "").strip()
    conto_carta = body.get("conto_carta", "").strip()
    importo_raw = body.get("importo", 0)

    # Validate required fields
    if not data_valuta or not operazione:
        return JSONResponse(
            status_code=400,
            content={"error": "Data e Operazione sono obbligatori."}
        )

    # Parse importo
    importo = parse_importo(importo_raw)

    # Validate date format
    try:
        datetime.strptime(data_valuta, '%Y-%m-%d')
    except ValueError:
        return JSONResponse(
            status_code=400,
            content={"error": "Formato data non valido. Usa YYYY-MM-DD."}
        )

    conn = get_db_connection()
    try:
        # Check expense exists
        existing = conn.execute(
            "SELECT id FROM expenses WHERE id = ?", (expense_id,)
        ).fetchone()
        if not existing:
            conn.close()
            return JSONResponse(
                status_code=404,
                content={"error": "Spesa non trovata."}
            )

        # Generate new hash for the updated data
        new_hash = generate_hash(data_valuta, importo, operazione, conto_carta)

        # Check for hash collision with a DIFFERENT record
        collision = conn.execute(
            "SELECT id FROM expenses WHERE hash_id = ? AND id != ?",
            (new_hash, expense_id)
        ).fetchone()
        if collision:
            conn.close()
            return JSONResponse(
                status_code=409,
                content={"error": "Una spesa identica è già presente."}
            )

        # Check neutral keyword match
        neutral_kws = get_neutral_keywords(conn)
        is_neutral = 1 if check_neutral(operazione, neutral_kws) else 0

        conn.execute("""
            UPDATE expenses
            SET data_valuta = ?,
                operazione = ?,
                conto_carta = ?,
                categoria = ?,
                importo = ?,
                hash_id = ?,
                is_neutral = ?
            WHERE id = ?
        """, (data_valuta, operazione, conto_carta, categoria, importo, new_hash, is_neutral, expense_id))
        conn.commit()

        # Return updated row
        row = conn.execute(
            "SELECT * FROM expenses WHERE id = ?", (expense_id,)
        ).fetchone()
        conn.close()

        return dict(row)

    except Exception as e:
        conn.close()
        return JSONResponse(
            status_code=500,
            content={"error": f"Errore durante l'aggiornamento: {str(e)}"}
        )


@app.post("/expenses")
async def create_expense(request: Request):
    """
    Create a manual expense entry.
    Expects JSON: { data_valuta, operazione, categoria, conto_carta, importo }
    """
    body = await request.json()

    data_valuta = body.get("data_valuta", "").strip()
    operazione = body.get("operazione", "").strip()
    categoria = body.get("categoria", "").strip()
    conto_carta = body.get("conto_carta", "").strip()
    importo_raw = body.get("importo", 0)

    if not data_valuta or not operazione:
        return JSONResponse(
            status_code=400,
            content={"error": "Data e Operazione sono obbligatori."}
        )

    importo = parse_importo(importo_raw)

    try:
        datetime.strptime(data_valuta, '%Y-%m-%d')
    except ValueError:
        return JSONResponse(
            status_code=400,
            content={"error": "Formato data non valido. Usa YYYY-MM-DD."}
        )

    hash_id = generate_hash(data_valuta, importo, operazione, conto_carta)

    conn = get_db_connection()
    try:
        existing = conn.execute(
            "SELECT id FROM expenses WHERE hash_id = ?", (hash_id,)
        ).fetchone()
        if existing:
            conn.close()
            return JSONResponse(
                status_code=409,
                content={"error": "Spesa duplicata già presente."}
            )

        neutral_kws = get_neutral_keywords(conn)
        is_neutral = 1 if check_neutral(operazione, neutral_kws) else 0

        conn.execute("""
            INSERT INTO expenses
                (data_valuta, operazione, conto_carta, categoria, valuta, importo, hash_id, is_neutral)
            VALUES (?, ?, ?, ?, 'EUR', ?, ?, ?)
        """, (data_valuta, operazione, conto_carta, categoria, importo, hash_id, is_neutral))
        conn.commit()

        row = conn.execute(
            "SELECT * FROM expenses WHERE hash_id = ?", (hash_id,)
        ).fetchone()
        conn.close()

        return dict(row)
    except Exception as e:
        conn.close()
        return JSONResponse(
            status_code=500,
            content={"error": f"Errore durante il salvataggio: {str(e)}"}
        )


@app.get("/available-periods")
async def get_available_periods():
    """Return all year/month combinations that have data, plus the latest period."""
    conn = get_db_connection()

    rows = conn.execute("""
        SELECT DISTINCT
            CAST(strftime('%Y', data_valuta) AS INTEGER) as year,
            CAST(strftime('%m', data_valuta) AS INTEGER) as month
        FROM expenses
        ORDER BY year DESC, month DESC
    """).fetchall()
    conn.close()

    if not rows:
        return {"periods": [], "latest_year": None, "latest_month": None}

    periods = []
    years_set = set()
    for row in rows:
        years_set.add(row['year'])
        periods.append({
            "year": row['year'],
            "month": row['month'],
            "month_name": MONTH_NAMES_IT.get(row['month'], str(row['month']))
        })

    return {
        "periods": periods,
        "years": sorted(years_set, reverse=True),
        "latest_year": rows[0]['year'],
        "latest_month": rows[0]['month']
    }


@app.get("/dashboard-stats")
async def get_dashboard_stats(
    year: int = Query(...),
    month: int = Query(...)
):
    """Dashboard statistics for a given month/year."""
    conn = get_db_connection()

    start_date = f"{year}-{month:02d}-01"
    if month == 12:
        end_date = f"{year + 1}-01-01"
    else:
        end_date = f"{year}-{month + 1:02d}-01"

    totals = conn.execute("""
        SELECT
            COALESCE(SUM(CASE WHEN importo > 0 THEN importo ELSE 0 END), 0) as entrate,
            COALESCE(SUM(CASE WHEN importo < 0 THEN importo ELSE 0 END), 0) as uscite,
            COALESCE(SUM(importo), 0) as saldo,
            COUNT(*) as count
        FROM expenses
        WHERE data_valuta >= ? AND data_valuta < ?
          AND is_excluded = 0
          AND is_neutral = 0
    """, (start_date, end_date)).fetchone()

    top_categories = conn.execute("""
        SELECT categoria, SUM(ABS(importo)) as totale
        FROM expenses
        WHERE data_valuta >= ? AND data_valuta < ?
          AND is_excluded = 0
          AND is_neutral = 0
          AND importo < 0
          AND categoria != '' AND categoria IS NOT NULL
        GROUP BY categoria
        ORDER BY totale DESC
        LIMIT 3
    """, (start_date, end_date)).fetchall()

    conn.close()

    return {
        "year": year,
        "month": month,
        "month_name": MONTH_NAMES_IT.get(month, str(month)),
        "entrate": round(totals['entrate'], 2),
        "uscite": round(abs(totals['uscite']), 2),
        "saldo": round(totals['saldo'], 2),
        "count": totals['count'],
        "top_categories": [
            {"categoria": row['categoria'], "totale": round(row['totale'], 2)}
            for row in top_categories
        ]
    }


# ── Monthly Reimbursement Status ─────────────────────────────────

@app.get("/monthly-status")
async def get_monthly_status():
    """Return paid/unpaid status for every month."""
    conn = get_db_connection()
    rows = conn.execute("SELECT month, year, is_paid FROM monthly_status").fetchall()
    conn.close()
    result = {}
    for r in rows:
        key = f"{r['year']}-{r['month']:02d}"
        result[key] = bool(r['is_paid'])
    return result


@app.post("/monthly-status")
async def set_monthly_status(request: Request):
    """Upsert is_paid flag for a given month/year."""
    body = await request.json()
    month = int(body["month"])
    year = int(body["year"])
    is_paid = 1 if body.get("is_paid") else 0

    conn = get_db_connection()
    conn.execute("""
        INSERT INTO monthly_status (month, year, is_paid)
        VALUES (?, ?, ?)
        ON CONFLICT(month, year) DO UPDATE SET is_paid = excluded.is_paid
    """, (month, year, is_paid))
    conn.commit()
    conn.close()
    return {"month": month, "year": year, "is_paid": bool(is_paid)}


# ── Bulk Delete Expenses ─────────────────────────────────────────

@app.delete("/expenses/bulk-delete")
async def bulk_delete_expenses(request: Request):
    """Delete all expenses for given month/year combos and reset monthly_status."""
    body = await request.json()
    periods = body.get("periods", [])
    if not periods:
        return JSONResponse(status_code=400, content={"error": "Nessun periodo specificato."})

    conn = get_db_connection()
    total_deleted = 0

    for p in periods:
        m, y = int(p["month"]), int(p["year"])
        start_date = f"{y}-{m:02d}-01"
        if m == 12:
            end_date = f"{y + 1}-01-01"
        else:
            end_date = f"{y}-{m + 1:02d}-01"

        cur = conn.execute(
            "DELETE FROM expenses WHERE data_valuta >= ? AND data_valuta < ?",
            (start_date, end_date)
        )
        total_deleted += cur.rowcount
        conn.execute(
            "DELETE FROM monthly_status WHERE month = ? AND year = ?",
            (m, y)
        )

    conn.commit()
    conn.close()
    return {"deleted": total_deleted}


# ── Delete Expense ───────────────────────────────────────────────

@app.delete("/expenses/{expense_id}")
async def delete_expense(expense_id: int):
    """Delete a single expense by ID."""
    conn = get_db_connection()
    row = conn.execute("SELECT id FROM expenses WHERE id = ?", (expense_id,)).fetchone()
    if not row:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Spesa non trovata."})

    conn.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
    conn.commit()
    conn.close()
    return {"deleted": expense_id}


# ── Neutral Keywords CRUD ────────────────────────────────────────

@app.get("/neutral-keywords")
async def get_keywords():
    """Return all neutral keywords, flagging those linked to a rimborso mittente."""
    conn = get_db_connection()
    rows = conn.execute("""
        SELECT nk.id, nk.keyword,
               CASE WHEN rm.keyword_id IS NOT NULL THEN 1 ELSE 0 END AS is_rimborso
        FROM neutral_keywords nk
        LEFT JOIN rimborso_mittenti rm ON rm.keyword_id = nk.id
        ORDER BY nk.keyword
    """).fetchall()
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
            (keyword.lower(),)
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, keyword FROM neutral_keywords WHERE keyword = ?", (keyword,)
        ).fetchone()
        conn.close()
        return {"id": row["id"], "keyword": row["keyword"]}
    except Exception:
        conn.close()
        return JSONResponse(status_code=409, content={"error": "Keyword già presente."})


@app.delete("/neutral-keywords/{kw_id}")
async def delete_keyword(kw_id: int):
    """Remove a neutral keyword, un-flag expenses, sever rimborso link if present."""
    conn = get_db_connection()
    row = conn.execute("SELECT keyword FROM neutral_keywords WHERE id = ?", (kw_id,)).fetchone()
    if not row:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Keyword non trovata."})

    keyword = row["keyword"]
    conn.execute("DELETE FROM neutral_keywords WHERE id = ?", (kw_id,))
    conn.execute(
        "UPDATE expenses SET is_neutral = 0 WHERE LOWER(TRIM(operazione)) = ?",
        (keyword.lower(),)
    )
    # Sever link from rimborso_mittenti without deleting the mittente
    conn.execute("UPDATE rimborso_mittenti SET keyword_id = NULL WHERE keyword_id = ?", (kw_id,))
    conn.commit()
    conn.close()
    return {"deleted": kw_id}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

# ── Rimborso Mittenti ────────────────────────────────────────────

@app.get("/rimborso-mittenti")
async def get_rimborso_mittenti():
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT id, operazione, keyword_id, tolleranza, attivo FROM rimborso_mittenti ORDER BY operazione"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/rimborso-mittenti")
async def add_rimborso_mittente(request: Request):
    """Add mittente and auto-create/link its neutral keyword."""
    body = await request.json()
    operazione = body.get("operazione", "").strip()
    tolleranza = float(body.get("tolleranza", 5.0))
    attivo = 1 if body.get("attivo", True) else 0

    if not operazione:
        return JSONResponse(status_code=400, content={"error": "Operazione obbligatoria."})

    conn = get_db_connection()
    try:
        existing_kw = conn.execute(
            "SELECT id FROM neutral_keywords WHERE LOWER(keyword) = ?", (operazione.lower(),)
        ).fetchone()
        if existing_kw:
            keyword_id = existing_kw["id"]
        else:
            conn.execute("INSERT INTO neutral_keywords (keyword) VALUES (?)", (operazione,))
            conn.execute(
                "UPDATE expenses SET is_neutral = 1 WHERE LOWER(TRIM(operazione)) = ?",
                (operazione.lower(),)
            )
            keyword_id = conn.execute(
                "SELECT id FROM neutral_keywords WHERE keyword = ?", (operazione,)
            ).fetchone()["id"]

        conn.execute(
            "INSERT INTO rimborso_mittenti (operazione, keyword_id, tolleranza, attivo) VALUES (?, ?, ?, ?)",
            (operazione, keyword_id, tolleranza, attivo)
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM rimborso_mittenti WHERE operazione = ?", (operazione,)
        ).fetchone()
        conn.close()
        return dict(row)
    except Exception as e:
        conn.close()
        return JSONResponse(status_code=409, content={"error": f"Mittente già presente: {str(e)}"})


@app.patch("/rimborso-mittenti/{mid}")
async def update_rimborso_mittente(mid: int, request: Request):
    body = await request.json()
    conn = get_db_connection()
    if not conn.execute("SELECT id FROM rimborso_mittenti WHERE id = ?", (mid,)).fetchone():
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Mittente non trovato."})
    if "tolleranza" in body:
        conn.execute("UPDATE rimborso_mittenti SET tolleranza = ? WHERE id = ?", (float(body["tolleranza"]), mid))
    if "attivo" in body:
        conn.execute("UPDATE rimborso_mittenti SET attivo = ? WHERE id = ?", (1 if body["attivo"] else 0, mid))
    conn.commit()
    row = conn.execute("SELECT * FROM rimborso_mittenti WHERE id = ?", (mid,)).fetchone()
    conn.close()
    return dict(row)


@app.delete("/rimborso-mittenti/{mid}")
async def delete_rimborso_mittente(mid: int):
    """Delete mittente and its linked neutral keyword."""
    conn = get_db_connection()
    row = conn.execute("SELECT operazione, keyword_id FROM rimborso_mittenti WHERE id = ?", (mid,)).fetchone()
    if not row:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Mittente non trovato."})
    keyword_id, operazione = row["keyword_id"], row["operazione"]
    conn.execute("DELETE FROM rimborso_mittenti WHERE id = ?", (mid,))
    if keyword_id:
        conn.execute("DELETE FROM neutral_keywords WHERE id = ?", (keyword_id,))
        conn.execute(
            "UPDATE expenses SET is_neutral = 0 WHERE LOWER(TRIM(operazione)) = ?",
            (operazione.lower(),)
        )
    conn.commit()
    conn.close()
    return {"deleted": mid}


@app.get("/detect-rimborso")
async def detect_rimborso():
    """Find reimbursement transactions matching active mittenti against unpaid months."""
    conn = get_db_connection()

    mittenti = conn.execute(
        "SELECT operazione, tolleranza FROM rimborso_mittenti WHERE attivo = 1"
    ).fetchall()
    if not mittenti:
        conn.close()
        return {"candidates": []}

    paid_keys = {
        (r["year"], r["month"])
        for r in conn.execute("SELECT year, month FROM monthly_status WHERE is_paid = 1").fetchall()
    }

    expense_months_rows = conn.execute("""
        SELECT DISTINCT
            CAST(strftime('%Y', data_valuta) AS INTEGER) AS year,
            CAST(strftime('%m', data_valuta)  AS INTEGER) AS month
        FROM expenses WHERE is_neutral = 0 ORDER BY year, month
    """).fetchall()

    unpaid = []
    for r in expense_months_rows:
        y, m = r["year"], r["month"]
        if (y, m) in paid_keys:
            continue
        sd = f"{y}-{m:02d}-01"
        ed = f"{y}-{m+1:02d}-01" if m < 12 else f"{y+1}-01-01"
        total = conn.execute("""
            SELECT COALESCE(SUM(importo),0) AS t FROM expenses
            WHERE data_valuta >= ? AND data_valuta < ? AND is_excluded=0 AND is_neutral=0
        """, (sd, ed)).fetchone()["t"]
        if abs(total) > 0.01:
            unpaid.append({"year": y, "month": m,
                           "month_name": MONTH_NAMES_IT.get(m, str(m)),
                           "amount": round(total, 2)})

    if not unpaid:
        conn.close()
        return {"candidates": []}

    candidates = []
    seen_tx_ids = set()

    for mit in mittenti:
        pattern, tolleranza = mit["operazione"], mit["tolleranza"]
        txs = conn.execute("""
            SELECT id, data_valuta, operazione, importo FROM expenses
            WHERE LOWER(TRIM(operazione)) LIKE ? AND importo > 0
            ORDER BY data_valuta DESC
        """, (f"%{pattern.lower()}%",)).fetchall()

        for tx in txs:
            if tx["id"] in seen_tx_ids:
                continue
            tx_amount, tx_date = tx["importo"], tx["data_valuta"]
            # Solo mesi PRECEDENTI alla data del bonifico
            eligible = [m for m in unpaid if f"{m['year']}-{m['month']:02d}-28" < tx_date]
            if not eligible:
                continue

            # Ordina cronologicamente per considerare solo finestre contigue
            eligible_sorted = sorted(eligible, key=lambda m: (m["year"], m["month"]))

            best = None
            # Itera su tutti i sottoinsiemi CONTIGUI (finestre consecutive) di lunghezza 1..4
            for start_idx in range(len(eligible_sorted)):
                cumulative = 0.0
                for end_idx in range(start_idx, min(start_idx + 4, len(eligible_sorted))):
                    combo = eligible_sorted[start_idx:end_idx + 1]
                    cumulative = sum(m["amount"] for m in combo)
                    diff = abs(abs(cumulative) - tx_amount)
                    if diff <= tolleranza and (best is None or diff < best["diff"]):
                        best = {
                            "transaction": dict(tx),
                            "months": list(combo),
                            "months_total": round(cumulative, 2),
                            "diff": round(diff, 2)
                        }

            if best:
                seen_tx_ids.add(tx["id"])
                candidates.append(best)

    conn.close()
    return {"candidates": candidates}
