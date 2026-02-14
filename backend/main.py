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

                # Insert new row
                conn.execute("""
                    INSERT INTO expenses
                        (data_valuta, operazione, conto_carta, categoria, valuta, importo, hash_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (data_valuta, operazione, conto_carta, categoria, valuta, importo, hash_id))

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
    """, (start_date, end_date)).fetchone()

    # Top 3 categories by cumulative spending (only negative importo = spending)
    top_categories = conn.execute("""
        SELECT categoria, SUM(ABS(importo)) as totale
        FROM expenses
        WHERE data_valuta >= ? AND data_valuta < ?
          AND is_excluded = 0
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
