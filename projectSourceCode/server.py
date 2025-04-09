from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import yfinance as yf
import os
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime

app = Flask(__name__, static_folder='.')
CORS(app)  # Enable CORS for all routes

PORT = 8000

# Database connection
def get_db_connection():
    return psycopg2.connect(
        host='db',
        database=os.getenv('POSTGRES_DB'),
        user=os.getenv('POSTGRES_USER'),
        password=os.getenv('POSTGRES_PASSWORD')
    )

@app.route('/api/stock')
def handle_stock_request():
    tickers = request.args.getlist('ticker')
    results = []

    for symbol in tickers:
        try:
            # First try to get from database
            conn = get_db_connection()
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SELECT * FROM stocks WHERE symbol = %s", (symbol.upper(),))
            db_stock = cur.fetchone()
            
            if db_stock:
                # Update price if data is older than 5 minutes
                if (datetime.now() - db_stock['last_updated']).total_seconds() > 300:
                    stock = yf.Ticker(symbol.upper())
                    info = stock.info
                    new_price = info.get("regularMarketPrice")
                    
                    cur.execute(
                        "UPDATE stocks SET last_price = %s, last_updated = CURRENT_TIMESTAMP WHERE symbol = %s",
                        (new_price, symbol.upper())
                    )
                    conn.commit()
                    
                    results.append({
                        "ticker": symbol.upper(),
                        "name": db_stock['company_name'],
                        "price": new_price
                    })
                else:
                    results.append({
                        "ticker": symbol.upper(),
                        "name": db_stock['company_name'],
                        "price": db_stock['last_price']
                    })
            else:
                # If not in database, fetch from Yahoo Finance and store
                stock = yf.Ticker(symbol.upper())
                info = stock.info
                name = info.get("shortName")
                price = info.get("regularMarketPrice")
                
                cur.execute(
                    "INSERT INTO stocks (symbol, company_name, last_price) VALUES (%s, %s, %s)",
                    (symbol.upper(), name, price)
                )
                conn.commit()
                
                results.append({
                    "ticker": symbol.upper(),
                    "name": name,
                    "price": price
                })
            
            cur.close()
            conn.close()
            
        except Exception as e:
            results.append({
                "ticker": symbol.upper(),
                "error": str(e)
            })

    return jsonify(results)

@app.route('/api/history')
def handle_history_request():
    ticker = request.args.get('ticker', '').upper()
    interval = request.args.get('interval', '5m')
    period = request.args.get('period', '1d')

    try:
        stock = yf.Ticker(ticker)
        history = stock.history(period=period, interval=interval)
        data = [
            {"time": str(index), "price": float(row["Close"])}
            for index, row in history.iterrows()
        ]
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Serve static files
@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

if __name__ == '__main__':
    print(f"Serving on http://localhost:{PORT}")
    app.run(host='0.0.0.0', port=PORT, debug=True)
