from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import yfinance as yf
import os
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime, timezone

app = Flask(__name__, static_folder='.')
CORS(app)

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
    live = request.args.get('live', 'false').lower() == 'true'
    results = []

    for symbol in tickers:
        try:
            symbol = symbol.upper()

            if live:
                stock = yf.Ticker(symbol)
                info = stock.info
                results.append({
                    "ticker": symbol,
                    "name": info.get("shortName"),
                    "price": info.get("regularMarketPrice"),
                    "open": info.get("open"),
                    "previousClose": info.get("previousClose"),
                    "dayLow": info.get("dayLow"),
                    "dayHigh": info.get("dayHigh"),
                    "yearLow": info.get("fiftyTwoWeekLow"),
                    "yearHigh": info.get("fiftyTwoWeekHigh"),
                    "marketCap": info.get("marketCap"),
                    "volume": info.get("volume")
                })
                continue

            conn = get_db_connection()
            cur = conn.cursor(cursor_factory=RealDictCursor)

            cur.execute("SELECT * FROM stocks WHERE symbol = %s", (symbol,))
            db_stock = cur.fetchone()

            if db_stock:
                last_updated = db_stock['last_updated']
                now = datetime.now(timezone.utc)
                if (now - last_updated).total_seconds() > 300:
                    stock = yf.Ticker(symbol)
                    info = stock.info
                    new_price = info.get("regularMarketPrice")

                    cur.execute(
                        "UPDATE stocks SET last_price = %s, last_updated = CURRENT_TIMESTAMP WHERE symbol = %s",
                        (new_price, symbol)
                    )
                    conn.commit()

                    results.append({
                        "ticker": symbol,
                        "name": db_stock['company_name'],
                        "price": new_price,
                        "open": info.get("regularMarketOpen"),
                    })
                else:
                    results.append({
                        "ticker": symbol,
                        "name": db_stock['company_name'],
                        "price": db_stock['last_price'],
                        "open": info.get("regularMarketOpen"),
                    })
            else:
                stock = yf.Ticker(symbol)
                info = stock.info
                name = info.get("shortName")
                price = info.get("regularMarketPrice")

                cur.execute(
                    "INSERT INTO stocks (symbol, company_name, last_price) VALUES (%s, %s, %s)",
                    (symbol, name, price)
                )
                conn.commit()

                results.append({
                    "ticker": symbol,
                    "name": name,
                    "price": price,
                    "open": info.get("regularMarketOpen"),
                })

            cur.close()
            conn.close()

        except Exception as e:
            results.append({
                "ticker": symbol,
                "error": str(e)
            })

    return jsonify(results)

@app.route('/api/history')
def handle_history_request():
    ticker = request.args.get('ticker', '').upper()
    period = request.args.get('period', '1d')

    interval_mapping = {
        '1d': '1m',
        '5d': '5m',
        '1mo': '15m',
        '3mo': '1h',
        '6mo': '1h',
        '1y': '1d',
        '5y': '5d',
    }

    if (period == 'ytd'):
        now = datetime.now()
        if now.month <= 6:  # jan to jun = less data, show more detail
            interval = '1h'
        else:
            interval = '1d'
    else:
        interval = interval_mapping.get(period, '1d')  # fallback

    try:
        stock = yf.Ticker(ticker)
        history = stock.history(period=period, interval=interval)

        data = [
            {
                "time": str(index), 
                "price": float(row["Close"])
            }
            for index, row in history.iterrows()
        ]
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/search')
def handle_search_request():
    query = request.args.get('query', '').strip().lower()
    
    if not query or len(query) < 2:
        return jsonify([])
    
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Search cached stocks first (faster)
        cur.execute("""
            SELECT 
                s.symbol, 
                s.company_name as name,
                s.last_price as price,
                CASE 
                    WHEN s.last_updated > NOW() - INTERVAL '15 minutes' THEN 'live'
                    ELSE 'cached'
                END as status
            FROM stocks s
            WHERE 
                LOWER(s.symbol) LIKE %s OR 
                LOWER(s.company_name) LIKE %s
            ORDER BY 
                CASE 
                    WHEN LOWER(s.symbol) = %s THEN 0
                    WHEN LOWER(s.symbol) LIKE %s THEN 1
                    ELSE 2
                END
            LIMIT 10
        """, (
            f'{query}%',
            f'%{query}%',
            query,
            f'{query}%'
        ))
        
        results = cur.fetchall()
        
        # If we found exact or prefix matches, return them immediately
        if any(r['symbol'].lower() == query for r in results):
            cur.close()
            conn.close()
            return jsonify(results)
        
        # Fall back to Yahoo Finance for more results
        yf_results = []
        search_data = yf.Tickers(query)
        
        for symbol, ticker in search_data.tickers.items():
            try:
                info = ticker.info
                yf_results.append({
                    "symbol": symbol,
                    "name": info.get('shortName', info.get('longName', symbol)),
                    "price": info.get('regularMarketPrice'),
                    "status": "live"
                })
                
                # Cache new results
                cur.execute("""
                    INSERT INTO stocks (symbol, company_name, last_price)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (symbol) 
                    DO UPDATE SET 
                        company_name = EXCLUDED.company_name,
                        last_price = EXCLUDED.last_price,
                        last_updated = CASE 
                            WHEN stocks.last_updated < NOW() - INTERVAL '15 minutes' 
                            THEN NOW() 
                            ELSE stocks.last_updated 
                        END
                """, (
                    symbol,
                    info.get('shortName', info.get('longName', symbol)),
                    info.get('regularMarketPrice')
                ))
                
            except Exception as e:
                print(f"Failed to process {symbol}: {str(e)}")
                continue
        
        conn.commit()
        cur.close()
        conn.close()
        
        # Combine and deduplicate results
        combined = {r['symbol']: r for r in results}
        for r in yf_results:
            if r['symbol'] not in combined:
                combined[r['symbol']] = r
        
        return jsonify(list(combined.values())[:10])
        
    except Exception as e:
        print(f"Search error: {str(e)}")
        return jsonify({"error": "Search service unavailable"}), 500

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
