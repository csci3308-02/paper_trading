from flask import Flask, render_template, request, redirect, url_for, session, jsonify, send_from_directory
from flask_cors import CORS
#from models import Base, User, Stock, Holding, Transaction
#from sqlalchemy import create_engine
#from sqlalchemy.orm import sessionmaker
import psycopg2
from psycopg2.extras import RealDictCursor
import os
from datetime import datetime, timezone, time, timedelta
from decimal import Decimal
import logging
import yfinance as yf
import pytz

app = Flask(__name__)
CORS(app)

# Configure logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

# Request logging middleware
@app.before_request
def log_request_info():
    logger.debug('Headers: %s', dict(request.headers))
    logger.debug('Body: %s', request.get_data())
    logger.debug('Method: %s, Path: %s', request.method, request.path)

PORT = 8000

# Database connection
def get_db_connection():
    return psycopg2.connect(
        host=os.getenv('PGHOST'),
        database=os.getenv('POSTGRES_DB'),
        user=os.getenv('POSTGRES_USER'),
        password=os.getenv('POSTGRES_PASSWORD')
    )

def is_market_open():
    """Check if US stock market is currently open"""
    # US Eastern timezone for market hours
    eastern = pytz.timezone('US/Eastern')
    now = datetime.now(eastern)
    
    # Check if it's a weekday (0 = Monday, 4 = Friday)
    if now.weekday() > 4:  # Weekend
        return False
    
    # Regular trading hours: 9:30 AM - 4:00 PM Eastern
    market_open = now.replace(hour=9, minute=30, second=0, microsecond=0)
    market_close = now.replace(hour=16, minute=0, second=0, microsecond=0)
    
    # Check if current time is within trading hours
    if market_open <= now <= market_close:
        # Could add holiday checking here if needed
        return True
    
    return False

def get_stock_price(symbol):
    """Get current stock price from Yahoo Finance"""
    try:
        stock = yf.Ticker(symbol)
        return Decimal(str(stock.info.get("regularMarketPrice", 0)))
    except:
        return None
    
@app.route('/api/price/<symbol>')
def get_price(symbol):
    """Return the current price for a single stock symbol"""
    symbol = symbol.upper()
    price = get_stock_price(symbol)
    if price is None:
        return jsonify({ 'error': 'Symbol not found or price unavailable' }), 404
    return jsonify({ 'price': float(price) })

def validate_trade(conn, user_id, symbol, quantity, trade_type):
    """Validate if a trade can be executed"""
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    try:
        # Get current stock price
        current_price = get_stock_price(symbol)
        if not current_price:
            return False, "Unable to get current stock price", None, None
        
        # Get stock ID or create new stock entry
        cur.execute("SELECT stock_id FROM stocks WHERE symbol = %s", (symbol,))
        stock_result = cur.fetchone()
        
        if not stock_result:
            # Stock doesn't exist in our database, create it
            stock = yf.Ticker(symbol)
            info = stock.info
            cur.execute(
                "INSERT INTO stocks (symbol, company_name, last_price) VALUES (%s, %s, %s) RETURNING stock_id",
                (symbol, info.get("shortName"), current_price)
            )
            stock_result = cur.fetchone()
        
        stock_id = stock_result['stock_id']
        
        # Get user's current balance
        cur.execute("SELECT balance FROM users WHERE user_id = %s", (user_id,))
        user = cur.fetchone()
        if not user:
            return False, "User not found", None, None
        
        balance = Decimal(str(user['balance']))
        
        if trade_type == 'BUY':
            total_cost = current_price * Decimal(str(quantity))
            if total_cost > balance:
                return False, "Insufficient funds", None, None
                
        elif trade_type == 'SELL':
            # Check if user has enough shares
            cur.execute(
                "SELECT quantity FROM holdings WHERE user_id = %s AND stock_id = %s",
                (user_id, stock_id)
            )
            holding = cur.fetchone()
            if not holding or Decimal(str(holding['quantity'])) < Decimal(str(quantity)):
                return False, "Insufficient shares", None, None
                
        return True, None, stock_id, current_price
        
    finally:
        cur.close()

@app.route('/api/trade', methods=['POST'])
def handle_trade():
    print("\n=== Trade Request Started ===")
    print("Headers:", dict(request.headers))
    print("Method:", request.method)
    print("Content-Type:", request.content_type)
    print("Raw Data:", request.get_data())
    
    try:
        # Ensure request has JSON content type
        if not request.is_json:
            print("Error: Request is not JSON")
            print("Content-Type:", request.content_type)
            return jsonify({"error": "Content-Type must be application/json"}), 400
            
        # Try to parse JSON data
        try:
            data = request.get_json(force=True)  # force=True will try to parse even if content-type is wrong
        except Exception as e:
            print("Error parsing JSON:", str(e))
            print("Raw data:", request.get_data())
            return jsonify({"error": "Invalid JSON data"}), 400
            
        if data is None:
            print("Error: No JSON data in request")
            return jsonify({"error": "No JSON data provided"}), 400
            
        print("Trade request data:", data)
        
        # Extract and validate required fields
        required_fields = ['user_id', 'symbol', 'quantity', 'trade_type']
        missing_fields = [field for field in required_fields if field not in data]
        if missing_fields:
            print(f"Error: Missing required fields: {missing_fields}")
            return jsonify({"error": f"Missing required fields: {missing_fields}"}), 400
            
        user_id = data['user_id']
        symbol = data['symbol'].upper()
        try:
            quantity = Decimal(str(data['quantity']))
        except (TypeError, ValueError) as e:
            print(f"Error converting quantity: {e}")
            return jsonify({"error": "Invalid quantity value"}), 400
            
        trade_type = data['trade_type'].upper()
        
        print(f"Processing trade: {trade_type} {quantity} {symbol} for user {user_id}")
        
        if not all([user_id, symbol, quantity > 0, trade_type in ['BUY', 'SELL']]):
            print("Invalid trade parameters")
            return jsonify({"error": "Invalid trade parameters"}), 400
            
        try:
            conn = get_db_connection()
            print("Database connection established")
        except Exception as e:
            print(f"Database connection error: {e}")
            return jsonify({"error": "Database connection failed"}), 500
        
        try:
            # Check if market is open
            market_open = is_market_open()
            print(f"Market is {'open' if market_open else 'closed'}")
            
            # Validate the trade
            print("Validating trade...")
            is_valid, error_msg, stock_id, current_price = validate_trade(
                conn, user_id, symbol, quantity, trade_type
            )
            
            if not is_valid:
                print(f"Trade validation failed: {error_msg}")
                return jsonify({"error": error_msg}), 400
                
            print(f"Trade validated. Stock ID: {stock_id}, Price: {current_price}")
            
            cur = conn.cursor(cursor_factory=RealDictCursor)
            
            # Start transaction
            cur.execute("BEGIN")
            print("Transaction started")
            
            try:
                total_amount = current_price * quantity
                
                if market_open:
                    # Execute the trade immediately
                    if trade_type == 'BUY':
                        # Update user's balance
                        cur.execute(
                            "UPDATE users SET balance = balance - %s WHERE user_id = %s",
                            (total_amount, user_id)
                        )
                        
                        # Update or insert holdings
                        cur.execute("""
                            INSERT INTO holdings (user_id, stock_id, quantity)
                            VALUES (%s, %s, %s)
                            ON CONFLICT (user_id, stock_id)
                            DO UPDATE SET quantity = holdings.quantity + %s
                        """, (user_id, stock_id, quantity, quantity))
                        
                    else:  # SELL
                        # Update user's balance
                        cur.execute(
                            "UPDATE users SET balance = balance + %s WHERE user_id = %s",
                            (total_amount, user_id)
                        )
                        
                        # Update holdings
                        cur.execute("""
                            UPDATE holdings 
                            SET quantity = quantity - %s
                            WHERE user_id = %s AND stock_id = %s
                        """, (quantity, user_id, stock_id))
                        
                        # Remove holding if quantity is 0
                        cur.execute("""
                            DELETE FROM holdings
                            WHERE user_id = %s AND stock_id = %s AND quantity <= 0
                        """, (user_id, stock_id))
                    
                    # Record the transaction
                    cur.execute("""
                        INSERT INTO transactions 
                        (user_id, stock_id, transaction_type, quantity, price)
                        VALUES (%s, %s, %s, %s, %s)
                    """, (user_id, stock_id, trade_type, quantity, current_price))
                    
                    response_message = f"{trade_type} order executed successfully"
                
                else:
                    # Queue the trade to execute when market opens
                    print("Market is closed. Queueing order for execution when market opens.")
                    
                    # Create a pending order
                    cur.execute("""
                        INSERT INTO pending_orders
                        (user_id, stock_id, order_type, quantity, price_at_creation, status)
                        VALUES (%s, %s, %s, %s, %s, 'PENDING')
                        RETURNING order_id
                    """, (user_id, stock_id, trade_type, quantity, current_price))
                    
                    order_result = cur.fetchone()
                    order_id = order_result['order_id']
                    
                    # For buy orders, reserve the funds
                    if trade_type == 'BUY':
                        # Create a reservation by updating the balance
                        # Note: Another approach would be to have a separate "reserved_balance" column
                        cur.execute(
                            "UPDATE users SET balance = balance - %s WHERE user_id = %s",
                            (total_amount, user_id)
                        )
                    
                    # For sell orders, mark the shares as pending sale
                    # This is a simplified approach; in a real system you might want to
                    # create a separate "pending_sales" table
                    
                    response_message = f"{trade_type} order queued for execution when market opens"
                
                # Commit transaction
                cur.execute("COMMIT")
                print("Transaction committed successfully")
                
                response_data = {
                    "success": True,
                    "message": response_message,
                    "price": float(current_price),
                    "total": float(total_amount),
                    "market_open": market_open
                }
                
                if not market_open:
                    response_data["order_id"] = str(order_id)
                    response_data["pending"] = True
                
                print("Sending success response:", response_data)
                return jsonify(response_data)
                
            except Exception as e:
                print(f"Error during transaction: {e}")
                cur.execute("ROLLBACK")
                raise e
                
        finally:
            conn.close()
            print("Database connection closed")
            
    except Exception as e:
        print(f"Unexpected error in handle_trade: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        print("=== Trade Request Ended ===\n")

@app.route('/api/holdings/<user_id>')
def get_holdings(user_id):
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        cur.execute("""
            SELECT 
                h.quantity,
                s.symbol,
                s.company_name,
                s.last_price,
                s.last_updated
            FROM holdings h
            JOIN stocks s ON h.stock_id = s.stock_id
            WHERE h.user_id = %s
        """, (user_id,))
        
        holdings = cur.fetchall()
        
        # Update prices for holdings if they're stale
        for holding in holdings:
            if (datetime.now(timezone.utc) - holding['last_updated']).total_seconds() > 300:
                current_price = get_stock_price(holding['symbol'])
                if current_price:
                    holding['last_price'] = float(current_price)
                    cur.execute(
                        "UPDATE stocks SET last_price = %s, last_updated = CURRENT_TIMESTAMP WHERE symbol = %s",
                        (current_price, holding['symbol'])
                    )
        
        conn.commit()
        cur.close()
        conn.close()
        
        return jsonify(holdings)
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

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
                    "open": info.get("regularMarketOpen"),
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

@app.route('/discover')

def discover():
    db_session = Session()
    try:
        user = db_session.query(User).filter(User.user_id == session['user_id']).first()
        stocks = db_session.query(Stock).all()
        return render_template('discover.html', user=user, stocks=stocks)
    finally:
        db_session.close()

@app.route('/chart')

def chart():
    return render_template('chart.html')

@app.route('/orderhistory')

def orderhistory():
    db_session = Session()
    try:
        transactions = db_session.query(Transaction).filter(
            Transaction.user_id == session['user_id']
        ).order_by(Transaction.transaction_date.desc()).all()
        return render_template('orderhistory.html', transactions=transactions)
    finally:
        db_session.close()

@app.route('/leaderboard')

def leaderboard():
    db_session = Session()
    try:
        users = db_session.query(User).order_by(User.balance.desc()).all()
        return render_template('leaderboard.html', users=users)
    finally:
        db_session.close()

@app.route('/logout')
def logout():
    session.pop('user_id', None)
    return redirect(url_for('login'))

# API Routes
@app.route('/api/stock/<symbol>')

def get_stock(symbol):
    db_session = Session()
    try:
        stock = db_session.query(Stock).filter(Stock.symbol == symbol).first()
        if not stock:
            return jsonify({'error': 'Stock not found'}), 404
        return jsonify({
            'symbol': stock.symbol,
            'company_name': stock.company_name,
            'last_price': float(stock.last_price) if stock.last_price else None,
            'last_updated': stock.last_updated.isoformat() if stock.last_updated else None
        })
    finally:
        db_session.close()

@app.route('/api/holdings', methods=['GET'])
def get_holdings1():
    try:
        # Get user_id from session or request headers
        user_id = request.headers.get('X-User-ID')
        if not user_id:
            return jsonify({"success": False, "message": "User not authenticated"}), 401
            
        # Get holdings from database
        session = Session()
        user = session.query(User).filter(User.user_id == user_id).first()
        if not user:
            return jsonify({"success": False, "message": "User not found"}), 404
            
        holdings = session.query(Holding).filter(Holding.user_id == user_id).all()
        
        holdings_data = []
        for holding in holdings:
            stock = session.query(Stock).filter(Stock.stock_id == holding.stock_id).first()
            holdings_data.append({
                'symbol': stock.symbol,
                'company_name': stock.company_name,
                'quantity': float(holding.quantity),
                'current_price': float(stock.last_price) if stock.last_price else None
            })
            
        return jsonify({
            "success": True, 
            "data": holdings_data,
            "balance": float(user.balance)
        }), 200
        
    except Exception as e:
        return jsonify({"success": False, "message": f"Error fetching holdings: {str(e)}"}), 500
    finally:
        session.close()

@app.route('/api/market-status', methods=['GET'])
def market_status():
    try:
        is_open = is_market_open()
        return jsonify({
            "success": True,
            "isOpen": is_open,
            "message": "Market is open" if is_open else "Market is closed"
        }), 200
    except Exception as e:
        return jsonify({
            "success": False,
            "message": f"Error checking market status: {str(e)}"
        }), 500

@app.route('/api/recent-trades', methods=['GET'])
def recent_trades():
    try:
        # Get user_id from session or request headers
        user_id = request.headers.get('X-User-ID')
        if not user_id:
            return jsonify({"success": False, "message": "User not authenticated"}), 401
            
        # Get recent trades from database
        session = Session()
        trades = session.query(Transaction, Stock).join(Stock).filter(
            Transaction.user_id == user_id
        ).order_by(Transaction.transaction_date.desc()).limit(10).all()
        
        trades_data = []
        for trade, stock in trades:
            trades_data.append({
                'transaction_date': trade.transaction_date.isoformat(),
                'symbol': stock.symbol,
                'transaction_type': trade.transaction_type,
                'quantity': float(trade.quantity),
                'price': float(trade.price)
            })
            
        return jsonify({"success": True, "data": trades_data}), 200
        
    except Exception as e:
        print(f"Search error: {str(e)}")
        return jsonify({"error": "Search service unavailable"}), 500

@app.route('/api/user/<user_id>/balance')
def get_user_balance(user_id):
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        cur.execute("SELECT balance FROM users WHERE user_id = %s", (user_id,))
        result = cur.fetchone()
        
        cur.close()
        conn.close()
        
        if result:
            return jsonify({"balance": float(result['balance'])})
        else:
            return jsonify({"error": "User not found"}), 404
            
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
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

@app.route('/api/pending-orders/<user_id>')
def get_pending_orders(user_id):
    """Get all pending orders for a user"""
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        cur.execute("""
            SELECT 
                po.order_id,
                po.order_type,
                po.quantity,
                po.created_at,
                po.status,
                po.price_at_creation,
                po.executed_price,
                po.executed_at,
                po.notes,
                s.symbol,
                s.company_name,
                s.last_price
            FROM pending_orders po
            JOIN stocks s ON po.stock_id = s.stock_id
            WHERE po.user_id = %s
            ORDER BY po.created_at DESC
        """, (user_id,))
        
        orders = cur.fetchall()
        
        # Convert datetime objects to strings for JSON serialization
        for order in orders:
            if order['created_at']:
                order['created_at'] = order['created_at'].isoformat()
            if order['executed_at']:
                order['executed_at'] = order['executed_at'].isoformat()
            
            # Format decimal values
            if order['quantity']:
                order['quantity'] = float(order['quantity'])
            if order['price_at_creation']:
                order['price_at_creation'] = float(order['price_at_creation'])
            if order['executed_price']:
                order['executed_price'] = float(order['executed_price'])
            if order['last_price']:
                order['last_price'] = float(order['last_price'])
        
        cur.close()
        conn.close()
        
        return jsonify(orders)
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def process_pending_orders():
    """Process all pending orders - should be called when market opens"""
    if not is_market_open():
        print("Market is not open. Skipping pending order processing.")
        return
        
    print("Market is open. Processing pending orders...")
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    try:
        # Get all pending orders
        cur.execute("""
            SELECT 
                po.order_id, 
                po.user_id, 
                po.stock_id, 
                po.order_type, 
                po.quantity, 
                po.price_at_creation,
                s.symbol
            FROM pending_orders po
            JOIN stocks s ON po.stock_id = s.stock_id
            WHERE po.status = 'PENDING'
            ORDER BY po.created_at
        """)
        
        pending_orders = cur.fetchall()
        print(f"Found {len(pending_orders)} pending orders to process")
        
        for order in pending_orders:
            print(f"Processing order {order['order_id']} for {order['symbol']}")
            
            try:
                # Update order status to processing
                cur.execute("""
                    UPDATE pending_orders SET status = 'PROCESSING' 
                    WHERE order_id = %s
                """, (order['order_id'],))
                conn.commit()
                
                # Get current price
                current_price = get_stock_price(order['symbol'])
                if not current_price:
                    # If we can't get a price, skip this order
                    cur.execute("""
                        UPDATE pending_orders 
                        SET status = 'FAILED', notes = 'Could not get current price'
                        WHERE order_id = %s
                    """, (order['order_id'],))
                    conn.commit()
                    continue
                
                # Start transaction for this order
                cur.execute("BEGIN")
                
                # Process based on order type
                if order['order_type'] == 'BUY':
                    # Note: We've already reserved funds when order was placed
                    
                    # Update or insert holdings
                    cur.execute("""
                        INSERT INTO holdings (user_id, stock_id, quantity)
                        VALUES (%s, %s, %s)
                        ON CONFLICT (user_id, stock_id)
                        DO UPDATE SET quantity = holdings.quantity + %s
                    """, (order['user_id'], order['stock_id'], order['quantity'], order['quantity']))
                    
                    # Handle price differences if needed
                    # In a real app, you might implement price slippage handling here
                    
                elif order['order_type'] == 'SELL':
                    # Check if user has enough shares
                    cur.execute("""
                        SELECT quantity FROM holdings 
                        WHERE user_id = %s AND stock_id = %s
                    """, (order['user_id'], order['stock_id']))
                    
                    holding = cur.fetchone()
                    if not holding or Decimal(str(holding['quantity'])) < Decimal(str(order['quantity'])):
                        # Not enough shares, mark as failed
                        cur.execute("""
                            UPDATE pending_orders 
                            SET status = 'FAILED', notes = 'Insufficient shares'
                            WHERE order_id = %s
                        """, (order['order_id'],))
                        cur.execute("COMMIT")
                        continue
                    
                    # Update holdings
                    cur.execute("""
                        UPDATE holdings 
                        SET quantity = quantity - %s
                        WHERE user_id = %s AND stock_id = %s
                    """, (order['quantity'], order['user_id'], order['stock_id']))
                    
                    # Remove holding if quantity is 0
                    cur.execute("""
                        DELETE FROM holdings
                        WHERE user_id = %s AND stock_id = %s AND quantity <= 0
                    """, (order['user_id'], order['stock_id']))
                    
                    # Update user's balance (for sell orders, we didn't reserve funds)
                    total_amount = current_price * Decimal(str(order['quantity']))
                    cur.execute("""
                        UPDATE users SET balance = balance + %s
                        WHERE user_id = %s
                    """, (total_amount, order['user_id']))
                
                # Record transaction
                cur.execute("""
                    INSERT INTO transactions 
                    (user_id, stock_id, transaction_type, quantity, price)
                    VALUES (%s, %s, %s, %s, %s)
                """, (order['user_id'], order['stock_id'], order['order_type'], 
                      order['quantity'], current_price))
                
                # Update order status
                cur.execute("""
                    UPDATE pending_orders
                    SET status = 'EXECUTED', executed_price = %s, executed_at = CURRENT_TIMESTAMP
                    WHERE order_id = %s
                """, (current_price, order['order_id']))
                
                # Commit this order's transaction
                cur.execute("COMMIT")
                print(f"Order {order['order_id']} executed successfully")
                
            except Exception as e:
                print(f"Error processing order {order['order_id']}: {e}")
                cur.execute("ROLLBACK")
                
                # Mark order as failed
                cur.execute("""
                    UPDATE pending_orders
                    SET status = 'FAILED', notes = %s
                    WHERE order_id = %s
                """, (str(e), order['order_id']))
                conn.commit()
    
    finally:
        cur.close()
        conn.close()
        print("Finished processing pending orders")

@app.route('/api/process-pending-orders', methods=['POST'])
def trigger_process_pending_orders():
    """API endpoint to manually trigger processing of pending orders"""
    # This could be called by a scheduled job when market opens
    if not is_market_open():
        return jsonify({
            "success": False,
            "message": "Market is not open. Cannot process pending orders."
        }), 400
        
    try:
        process_pending_orders()
        return jsonify({
            "success": True,
            "message": "Pending orders processed successfully"
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "message": f"Error processing pending orders: {str(e)}"
        }), 500

@app.route('/api/cancel-order/<order_id>', methods=['POST'])
def cancel_order(order_id):
    """Cancel a pending order if it hasn't been executed yet"""
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Start transaction
        cur.execute("BEGIN")
        
        # Check if order exists and is still pending
        cur.execute("""
            SELECT po.*, s.symbol
            FROM pending_orders po
            JOIN stocks s ON po.stock_id = s.stock_id
            WHERE po.order_id = %s AND po.status = 'PENDING'
        """, (order_id,))
        
        order = cur.fetchone()
        if not order:
            cur.execute("ROLLBACK")
            return jsonify({
                "success": False,
                "message": "Order not found or already being processed"
            }), 404
        
        # If it's a BUY order, refund the reserved funds
        if order['order_type'] == 'BUY':
            total_amount = Decimal(str(order['quantity'])) * Decimal(str(order['price_at_creation']))
            cur.execute("""
                UPDATE users 
                SET balance = balance + %s 
                WHERE user_id = %s
            """, (total_amount, order['user_id']))
        
        # Update the order status
        cur.execute("""
            UPDATE pending_orders 
            SET status = 'CANCELLED', notes = 'Cancelled by user'
            WHERE order_id = %s
        """, (order_id,))
        
        # Commit the transaction
        cur.execute("COMMIT")
        
        return jsonify({
            "success": True,
            "message": f"Successfully cancelled {order['order_type']} order for {order['quantity']} {order['symbol']}"
        })
        
    except Exception as e:
        if 'conn' in locals() and 'cur' in locals():
            cur.execute("ROLLBACK")
        return jsonify({
            "success": False,
            "message": f"Error cancelling order: {str(e)}"
        }), 500
    finally:
        if 'conn' in locals() and 'cur' in locals():
            cur.close()
            conn.close()

if __name__ == '__main__':
    # Check for and process pending orders on startup if market is open
    if is_market_open():
        print("Market is open. Processing any pending orders...")
        process_pending_orders()
    else:
        print("Market is closed. Will process pending orders when market opens.")
        
    # Start the server
    app.run(host='0.0.0.0', port=8000, debug=True)