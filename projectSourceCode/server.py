from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import yfinance as yf
import os

app = Flask(__name__, static_folder='.')
CORS(app)  # Enable CORS for all routes

PORT = 8000

@app.route('/api/stock')
def handle_stock_request():
    tickers = request.args.getlist('ticker')
    results = []

    for symbol in tickers:
        try:
            stock = yf.Ticker(symbol.upper())
            info = stock.info
            results.append({
                "ticker": symbol.upper(),
                "name": info.get("shortName"),
                "price": info.get("regularMarketPrice")
            })
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
