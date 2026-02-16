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
    Parse Italian-format currency string to float.
    Examples: "1.200,50 €" → 1200.50, "-45,00" → -45.0
    """
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    # Remove currency symbols and whitespace
    s = re.sub(r'[€$£\s]', '', s)
    # Italian format: 1.200,50 → remove dots, replace comma with dot
    s = s.replace('.', '').replace(',', '.')
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
    # Read Excel, skipping first 18 rows (header at row 19 = index 18)
    df = pd.read_excel(
        io.BytesIO(file_bytes),
        header=18,  # Row 19 is the header (0-indexed: 18)
        engine='openpyxl'
    )

    # Clean column names (strip whitespace)
    df.columns = df.columns.str.strip()

    # Drop completely empty rows
    df = df.dropna(how='all')

    stats = {"new": 0, "duplicates": 0, "fuzzy_matches": [], "errors": 0}
    conn = get_db_connection()
    neutral_kws = get_neutral_keywords(conn)

    try:
        for _, row in df.iterrows():
            try:
                # Extract and parse fields
                data_raw = row.get('Data', None)
                if pd.isna(data_raw):
                    continue

                # Parse date
                if isinstance(data_raw, datetime):
                    data_valuta = data_raw.strftime('%Y-%m-%d')
                elif isinstance(data_raw, str):
                    # Try common Italian formats
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

                # Skip rows with no meaningful data
                if not operazione or operazione == 'nan':
                    continue

                # Clean 'nan' values
                if conto_carta == 'nan':
                    conto_carta = ''
                if categoria == 'nan':
                    categoria = ''
                if valuta == 'nan':
                    valuta = 'EUR'

                # Generate hash for exact duplicate check
                hash_id = generate_hash(data_valuta, importo, operazione, conto_carta)

                # Check exact duplicate
                existing = conn.execute(
                    "SELECT id FROM expenses WHERE hash_id = ?", (hash_id,)
                ).fetchone()

                if existing:
                    stats["duplicates"] += 1
                    continue

                # Fuzzy duplicate check
                if check_fuzzy_duplicate(conn, data_valuta, importo, operazione):
                    stats["fuzzy_matches"].append({
                        "data": data_valuta,
                        "operazione": operazione,
                        "importo": importo
                    })
                    stats["duplicates"] += 1
                    continue

                # Check neutral keyword match
                is_neutral = 1 if check_neutral(operazione, neutral_kws) else 0

                # Insert new row
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
    """
    Upload an Excel file, process it, and return ingestion stats.
    """
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

    # Group by Year > Month
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

    # Sort years descending, months by calendar order (desc)
    result = {}
    for year in sorted(grouped.keys(), reverse=True):
        months_data = grouped[year]
        # Sort months by calendar order (most recent first)
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

    # Validate required fields
    if not data_valuta or not operazione:
        return JSONResponse(
            status_code=400,
            content={"error": "Data e Operazione sono obbligatori."}
        )

    # Parse importo (accept both Italian and standard formats)
    importo = parse_importo(importo_raw)

    # Validate date format
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
        # Check for duplicates
        existing = conn.execute(
            "SELECT id FROM expenses WHERE hash_id = ?", (hash_id,)
        ).fetchone()
        if existing:
            conn.close()
            return JSONResponse(
                status_code=409,
                content={"error": "Spesa duplicata già presente."}
            )

        # Check neutral keyword match
        neutral_kws = get_neutral_keywords(conn)
        is_neutral = 1 if check_neutral(operazione, neutral_kws) else 0

        conn.execute("""
            INSERT INTO expenses
                (data_valuta, operazione, conto_carta, categoria, valuta, importo, hash_id, is_neutral)
            VALUES (?, ?, ?, ?, 'EUR', ?, ?, ?)
        """, (data_valuta, operazione, conto_carta, categoria, importo, hash_id, is_neutral))
        conn.commit()

        # Retrieve the created row
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
    """
    Return all year/month combinations that have data, plus the latest period.
    Used to populate the dashboard filter dropdowns.
    """
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
    """
    Dashboard statistics for a given month/year.
    Returns totals (entrate, uscite, saldo) and top 3 spending categories.
    Excludes rows where is_excluded = 1.
    """
    conn = get_db_connection()

    # Build date range for the requested month
    start_date = f"{year}-{month:02d}-01"
    if month == 12:
        end_date = f"{year + 1}-01-01"
    else:
        end_date = f"{year}-{month + 1:02d}-01"

    # Totals: Entrate (importo > 0) and Uscite (importo < 0)
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

    # Top 3 categories by cumulative spending (only negative importo = spending)
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

        print(f"DEBUG: Processing deletion for {m}/{y}...")
        cur = conn.execute(
            "DELETE FROM expenses WHERE data_valuta >= ? AND data_valuta < ?",
            (start_date, end_date)
        )
        deleted_count = cur.rowcount
        total_deleted += deleted_count
        print(f"DEBUG: Deleted {deleted_count} expenses for {m}/{y}")

        conn.execute(
            "DELETE FROM monthly_status WHERE month = ? AND year = ?",
            (m, y)
        )

    conn.commit()
    print(f"DEBUG: Commit executed. Total deleted: {total_deleted}")
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
    """Return all neutral keywords."""
    conn = get_db_connection()
    rows = conn.execute("SELECT id, keyword FROM neutral_keywords ORDER BY keyword").fetchall()
    conn.close()
    return [{"id": r["id"], "keyword": r["keyword"]} for r in rows]


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
        # Re-flag existing expenses that match this keyword
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
    """Remove a neutral keyword and un-flag matching expenses."""
    conn = get_db_connection()
    row = conn.execute("SELECT keyword FROM neutral_keywords WHERE id = ?", (kw_id,)).fetchone()
    if not row:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Keyword non trovata."})

    keyword = row["keyword"]
    conn.execute("DELETE FROM neutral_keywords WHERE id = ?", (kw_id,))
    # Un-flag expenses (only if no other keyword matches)
    conn.execute(
        "UPDATE expenses SET is_neutral = 0 WHERE LOWER(TRIM(operazione)) = ?",
        (keyword.lower(),)
    )
    conn.commit()
    conn.close()
    return {"deleted": kw_id}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
