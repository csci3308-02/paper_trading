import http.server
import socketserver
import urllib.parse
import json
import yfinance as yf
import os

PORT = 8000

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path
        params = urllib.parse.parse_qs(url.query)

        if path == "/api/stock":
            self.handle_stock_request(params)

        elif path == "/api/history":
            self.handle_history_request(params)

        else:
            super().do_GET()

    def handle_stock_request(self, params):
        tickers = params.get("ticker", [])
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

        self.respond_json(results)

    def handle_history_request(self, params):
        ticker = params.get("ticker", [""])[0].upper()
        interval = params.get("interval", ["5m"])[0]
        period = params.get("period", ["1d"])[0]

        try:
            stock = yf.Ticker(ticker)
            history = stock.history(period=period, interval=interval)
            data = [
                {"time": str(index), "price": float(row["Close"])}
                for index, row in history.iterrows()
            ]
            self.respond_json(data)
        except Exception as e:
            self.send_error(500, message=str(e))

    def respond_json(self, data):
        self.send_response(200)
        self.send_header("Content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

# Serve files from the script's directory
os.chdir(os.path.dirname(os.path.abspath(__file__)))

with socketserver.TCPServer(("", PORT), CustomHandler) as httpd:
    print(f"Serving on http://localhost:{PORT}")
    httpd.serve_forever()
