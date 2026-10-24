import os
import csv
import io
import sqlite3
from datetime import datetime, date
from flask import Flask, render_template, request, jsonify, Response

app = Flask(__name__)

# Path to SQLite database file (created automatically when the app starts)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "expenses.db")

ALLOWED_CATEGORIES = [
    "Food",
    "Travel",
    "Books",
    "Shopping",
    "Party",
    "Utilities",
    "Health",
    "Entertainment",
    "Other",
]


def get_db_connection():
    """Create and return a database connection with Row factory enabled."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def parse_and_normalize_date(date_str):
    """
    Validate and normalize an input date string.
    Supports both 'DD/MM/YY' (from existing CLI project) and 'YYYY-MM-DD' (HTML5 date input),
    as well as 'DD/MM/YYYY'.
    Returns tuple: (iso_date 'YYYY-MM-DD', display_date 'DD/MM/YY') or raises ValueError.
    """
    if not date_str or not isinstance(date_str, str):
        raise ValueError("Date is required.")

    cleaned = date_str.strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%y", "%d/%m/%Y"):
        try:
            parsed = datetime.strptime(cleaned, fmt).date()
            return parsed.strftime("%Y-%m-%d"), parsed.strftime("%d/%m/%y")
        except ValueError:
            continue

    raise ValueError("Invalid date format. Please use DD/MM/YY or YYYY-MM-DD.")


def format_display_date(iso_date_str):
    """Convert stored YYYY-MM-DD into DD/MM/YY for display alongside ISO date."""
    try:
        parsed = datetime.strptime(iso_date_str, "%Y-%m-%d").date()
        return parsed.strftime("%d/%m/%y")
    except Exception:
        return iso_date_str


def validate_expense_payload(data):
    """
    Validate incoming expense payload for required fields, valid date,
    valid category, non-empty description, and positive numerical amount.
    """
    if not data:
        return None, "Request payload cannot be empty."

    raw_date = str(data.get("date", "")).strip()
    category = str(data.get("category", "")).strip()
    description = str(data.get("description", "")).strip()
    raw_amount = data.get("amount", "")

    if not raw_date:
        return None, "Please provide a valid expense date."

    try:
        iso_date, _ = parse_and_normalize_date(raw_date)
    except ValueError as err:
        return None, str(err)

    if not category:
        return None, "Please select an expense category."

    if category not in ALLOWED_CATEGORIES:
        return None, f"Invalid category '{category}'. Choose from {', '.join(ALLOWED_CATEGORIES)}."

    if not description:
        return None, "Description cannot be empty."

    if len(description) > 200:
        return None, "Description must be 200 characters or fewer."

    try:
        amount = float(raw_amount)
    except (ValueError, TypeError):
        return None, "Amount must be a valid number."

    if amount <= 0:
        return None, "Amount must be greater than zero."

    if amount > 10_000_000:
        return None, "Amount exceeds the maximum allowed limit."

    return {
        "date": iso_date,
        "category": category,
        "description": description,
        "amount": round(amount, 2),
    }, None


def init_db():
    """Initialize the SQLite database and create the expenses table if it doesn't exist."""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                category TEXT NOT NULL,
                description TEXT NOT NULL,
                amount REAL NOT NULL CHECK(amount > 0),
                created_at TEXT NOT NULL
            )
            """
        )

        # Check if database is empty; if so, insert starter sample expenses
        cursor.execute("SELECT COUNT(*) AS count FROM expenses")
        row = cursor.fetchone()
        if row and row["count"] == 0:
            today = date.today()
            current_ym = today.strftime("%Y-%m")
            today_iso = today.strftime("%Y-%m-%d")
            now_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            starter_expenses = [
                (today_iso, "Food", "Lunch thali and fresh coffee at campus cafe", 240.00, now_ts),
                (today_iso, "Travel", "Metro smart card recharge and auto fare", 300.00, now_ts),
                (f"{current_ym}-05", "Books", "Python Crash Course & Data Structures reference", 895.00, now_ts),
                (f"{current_ym}-09", "Shopping", "Wireless mouse and USB-C hub", 1450.00, now_ts),
                (f"{current_ym}-12", "Party", "Birthday pizza dinner with hostel friends", 1120.00, now_ts),
                (f"{current_ym}-15", "Utilities", "High-speed fiber broadband monthly bill", 799.00, now_ts),
                (f"{current_ym}-18", "Food", "Weekly groceries, fruits, and oats", 680.00, now_ts),
                (f"{current_ym}-20", "Entertainment", "Weekend movie ticket and popcorn", 420.00, now_ts),
            ]
            cursor.executemany(
                """
                INSERT INTO expenses (date, category, description, amount, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                starter_expenses,
            )

        conn.commit()
        conn.close()
    except sqlite3.Error as err:
        print(f"Database initialization error: {err}")


def serialize_expense(row):
    """Convert a sqlite3.Row object into a dictionary with both ISO and DD/MM/YY date."""
    iso_date = row["date"]
    return {
        "id": row["id"],
        "date": iso_date,
        "display_date": format_display_date(iso_date),
        "category": row["category"],
        "description": row["description"],
        "amount": round(float(row["amount"]), 2),
        "created_at": row["created_at"],
    }


# ---------------------------------------------------------------------------
# HTML Page Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    """Render the main Dashboard view."""
    return render_template("index.html", categories=ALLOWED_CATEGORIES)


@app.route("/expenses")
def expenses_page():
    """Render the full Searchable & Filterable Expenses Ledger page."""
    return render_template("expenses.html", categories=ALLOWED_CATEGORIES)


# ---------------------------------------------------------------------------
# REST API Routes (CRUD + Filtering + Summaries + CSV Export)
# ---------------------------------------------------------------------------

@app.route("/api/expenses", methods=["GET"])
def get_expenses():
    """
    Fetch expenses with optional query parameters:
    - category: filter by category name (or 'All')
    - start_date: filter expenses on or after date (YYYY-MM-DD or DD/MM/YY)
    - end_date: filter expenses on or before date (YYYY-MM-DD or DD/MM/YY)
    - search: case-insensitive search in description or category
    - sort_by: 'date', 'amount', 'category', 'description'
    - sort_order: 'asc' or 'desc'
    """
    category = request.args.get("category", "").strip()
    start_date = request.args.get("start_date", "").strip()
    end_date = request.args.get("end_date", "").strip()
    search = request.args.get("search", "").strip()
    sort_by = request.args.get("sort_by", "date").strip().lower()
    sort_order = request.args.get("sort_order", "desc").strip().lower()

    allowed_sort_columns = {
        "date": "date",
        "amount": "amount",
        "category": "category",
        "description": "description",
        "id": "id",
    }
    sort_column = allowed_sort_columns.get(sort_by, "date")
    order_sql = "ASC" if sort_order == "asc" else "DESC"

    query = "SELECT id, date, category, description, amount, created_at FROM expenses WHERE 1=1"
    params = []

    if category and category.lower() != "all":
        query += " AND category = ?"
        params.append(category)

    if start_date:
        try:
            iso_start, _ = parse_and_normalize_date(start_date)
            query += " AND date >= ?"
            params.append(iso_start)
        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400

    if end_date:
        try:
            iso_end, _ = parse_and_normalize_date(end_date)
            query += " AND date <= ?"
            params.append(iso_end)
        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400

    if search:
        query += " AND (LOWER(description) LIKE ? OR LOWER(category) LIKE ?)"
        wildcard = f"%{search.lower()}%"
        params.extend([wildcard, wildcard])

    query += f" ORDER BY {sort_column} {order_sql}, id DESC"

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()

        expenses = [serialize_expense(r) for r in rows]
        filtered_total = round(sum(item["amount"] for item in expenses), 2)

        return jsonify({
            "success": True,
            "expenses": expenses,
            "filtered_total": filtered_total,
            "count": len(expenses),
        })
    except sqlite3.Error as err:
        return jsonify({"success": False, "error": f"Database error: {err}"}), 500


@app.route("/api/expenses", methods=["POST"])
def add_expense():
    """Add a new expense record using parameterized SQL queries."""
    data = request.get_json(silent=True) or request.form.to_dict()
    cleaned, error = validate_expense_payload(data)
    if error:
        return jsonify({"success": False, "error": error}), 400

    created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO expenses (date, category, description, amount, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                cleaned["date"],
                cleaned["category"],
                cleaned["description"],
                cleaned["amount"],
                created_at,
            ),
        )
        new_id = cursor.lastrowid
        conn.commit()

        cursor.execute(
            "SELECT id, date, category, description, amount, created_at FROM expenses WHERE id = ?",
            (new_id,),
        )
        new_row = cursor.fetchone()
        conn.close()

        return jsonify({
            "success": True,
            "message": "Expense added successfully.",
            "expense": serialize_expense(new_row),
        }), 201
    except sqlite3.Error as err:
        return jsonify({"success": False, "error": f"Failed to save expense: {err}"}), 500


@app.route("/api/expenses/<int:expense_id>", methods=["PUT"])
def update_expense(expense_id):
    """Update an existing expense by ID."""
    data = request.get_json(silent=True) or request.form.to_dict()
    cleaned, error = validate_expense_payload(data)
    if error:
        return jsonify({"success": False, "error": error}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute("SELECT id FROM expenses WHERE id = ?", (expense_id,))
        existing = cursor.fetchone()
        if not existing:
            conn.close()
            return jsonify({"success": False, "error": "Expense record not found."}), 404

        cursor.execute(
            """
            UPDATE expenses
            SET date = ?, category = ?, description = ?, amount = ?
            WHERE id = ?
            """,
            (
                cleaned["date"],
                cleaned["category"],
                cleaned["description"],
                cleaned["amount"],
                expense_id,
            ),
        )
        conn.commit()

        cursor.execute(
            "SELECT id, date, category, description, amount, created_at FROM expenses WHERE id = ?",
            (expense_id,),
        )
        updated_row = cursor.fetchone()
        conn.close()

        return jsonify({
            "success": True,
            "message": "Expense updated successfully.",
            "expense": serialize_expense(updated_row),
        })
    except sqlite3.Error as err:
        return jsonify({"success": False, "error": f"Failed to update expense: {err}"}), 500


@app.route("/api/expenses/<int:expense_id>", methods=["DELETE"])
def delete_expense(expense_id):
    """Delete an existing expense by ID."""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM expenses WHERE id = ?", (expense_id,))
        existing = cursor.fetchone()
        if not existing:
            conn.close()
            return jsonify({"success": False, "error": "Expense record not found."}), 404

        cursor.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
        conn.commit()
        conn.close()

        return jsonify({
            "success": True,
            "message": "Expense deleted successfully.",
            "deleted_id": expense_id,
        })
    except sqlite3.Error as err:
        return jsonify({"success": False, "error": f"Failed to delete expense: {err}"}), 500


@app.route("/api/summary", methods=["GET"])
def get_summary():
    """
    Calculate dashboard KPIs, category-wise breakdown, and monthly spending breakdown.
    """
    today_iso = date.today().strftime("%Y-%m-%d")
    current_month_prefix = date.today().strftime("%Y-%m")

    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        # 1. Overall total and transaction count
        cursor.execute(
            "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM expenses"
        )
        overall = cursor.fetchone()
        total_expenses = round(float(overall["total"]), 2)
        total_transactions = int(overall["count"])

        # 2. Current month expenses
        cursor.execute(
            "SELECT COALESCE(SUM(amount), 0) AS month_total FROM expenses WHERE strftime('%Y-%m', date) = ?",
            (current_month_prefix,),
        )
        month_row = cursor.fetchone()
        month_expenses = round(float(month_row["month_total"]), 2)

        # 3. Today's expenses
        cursor.execute(
            "SELECT COALESCE(SUM(amount), 0) AS today_total FROM expenses WHERE date = ?",
            (today_iso,),
        )
        today_row = cursor.fetchone()
        today_expenses = round(float(today_row["today_total"]), 2)

        # 4. Category-wise breakdown
        cursor.execute(
            """
            SELECT category,
                   ROUND(SUM(amount), 2) AS total,
                   COUNT(*) AS count
            FROM expenses
            GROUP BY category
            ORDER BY total DESC
            """
        )
        cat_rows = cursor.fetchall()
        categories_summary = []
        for r in cat_rows:
            cat_total = round(float(r["total"]), 2)
            pct = round((cat_total / total_expenses) * 100, 1) if total_expenses > 0 else 0.0
            categories_summary.append({
                "category": r["category"],
                "total": cat_total,
                "count": int(r["count"]),
                "percentage": pct,
            })

        # 5. Monthly breakdown (last 12 months with data)
        cursor.execute(
            """
            SELECT strftime('%Y-%m', date) AS month,
                   ROUND(SUM(amount), 2) AS total,
                   COUNT(*) AS count
            FROM expenses
            GROUP BY month
            ORDER BY month ASC
            LIMIT 12
            """
        )
        month_rows = cursor.fetchall()
        monthly_summary = [
            {
                "month": r["month"],
                "total": round(float(r["total"]), 2),
                "count": int(r["count"]),
            }
            for r in month_rows
        ]

        conn.close()

        return jsonify({
            "success": True,
            "kpis": {
                "total_expenses": total_expenses,
                "month_expenses": month_expenses,
                "today_expenses": today_expenses,
                "total_transactions": total_transactions,
            },
            "category_breakdown": categories_summary,
            "monthly_breakdown": monthly_summary,
        })
    except sqlite3.Error as err:
        return jsonify({"success": False, "error": f"Failed to calculate summary: {err}"}), 500


@app.route("/api/export-csv", methods=["GET"])
def export_csv():
    """Export filtered or all expenses as a downloadable CSV file."""
    category = request.args.get("category", "").strip()
    start_date = request.args.get("start_date", "").strip()
    end_date = request.args.get("end_date", "").strip()
    search = request.args.get("search", "").strip()

    query = "SELECT id, date, category, description, amount, created_at FROM expenses WHERE 1=1"
    params = []

    if category and category.lower() != "all":
        query += " AND category = ?"
        params.append(category)

    if start_date:
        try:
            iso_start, _ = parse_and_normalize_date(start_date)
            query += " AND date >= ?"
            params.append(iso_start)
        except ValueError:
            pass

    if end_date:
        try:
            iso_end, _ = parse_and_normalize_date(end_date)
            query += " AND date <= ?"
            params.append(iso_end)
        except ValueError:
            pass

    if search:
        query += " AND (LOWER(description) LIKE ? OR LOWER(category) LIKE ?)"
        wildcard = f"%{search.lower()}%"
        params.extend([wildcard, wildcard])

    query += " ORDER BY date DESC, id DESC"

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["ID", "Date (DD/MM/YY)", "ISO Date", "Category", "Description", "Amount", "Created At"])

        for row in rows:
            writer.writerow([
                row["id"],
                format_display_date(row["date"]),
                row["date"],
                row["category"],
                row["description"],
                f"{float(row['amount']):.2f}",
                row["created_at"],
            ])

        csv_content = output.getvalue()
        output.close()

        filename = f"expenses_export_{date.today().strftime('%Y%m%d')}.csv"
        return Response(
            csv_content,
            mimetype="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
    except sqlite3.Error as err:
        return jsonify({"success": False, "error": f"Failed to export CSV: {err}"}), 500


if __name__ == "__main__":
    init_db()
    print("Starting Expense Tracker Web Application on http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=True)