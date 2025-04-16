from flask import Flask, render_template, request, redirect, url_for, session, jsonify
from flask_cors import CORS
from models import Base, User, Stock, Holding, Transaction
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import os
from datetime import datetime, timezone
from decimal import Decimal
import logging

app = Flask(__name__)
CORS(app)

# Configure logging
logging.basicConfig(level=logging.DEBUG)
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
        host='db',
        database=os.getenv('POSTGRES_DB'),
        user=os.getenv('POSTGRES_USER'),
        password=os.getenv('POSTGRES_PASSWORD')
    )

def get_stock_price(symbol):
    """Get current stock price from Yahoo Finance"""
    try:
        stock = yf.Ticker(symbol)
        return Decimal(str(stock.info.get("regularMarketPrice", 0)))
    except:
        return None

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
            # Validate the trade
            print("Validating trade...")
            is_valid, error_msg, stock_id, current_price = validate_trade(
                conn, user_id, symbol, quantity, trade_type
            )
            
            if not is_valid:
                print(f"Trade validation failed: {error_msg}")
                return jsonify({"error": error_msg}), 400
                
            print(f"Trade validated. Stock ID: {stock_id}, Price: {current_price}")
            
            cur = conn.cursor()
            
            # Start transaction
            cur.execute("BEGIN")
            print("Transaction started")
            
            try:
                total_amount = current_price * quantity
                
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
                
                # Commit transaction
                cur.execute("COMMIT")
                print("Transaction committed successfully")
                
                response_data = {
                    "success": True,
                    "message": f"{trade_type} order executed successfully",
                    "price": float(current_price),
                    "total": float(total_amount)
                }
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
                        "price": new_price
                    })
                else:
                    results.append({
                        "ticker": symbol,
                        "name": db_stock['company_name'],
                        "price": db_stock['last_price']
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
                    "price": price
                })

            cur.close()
            conn.close()

        except Exception as e:
            db_session.rollback()
            return render_template('register.html', error='Registration failed')
        finally:
            db_session.close()
    return render_template('register.html')

@app.route('/discover')
@auth_required
def discover():
    db_session = Session()
    try:
        user = db_session.query(User).filter(User.user_id == session['user_id']).first()
        stocks = db_session.query(Stock).all()
        return render_template('discover.html', user=user, stocks=stocks)
    finally:
        db_session.close()

@app.route('/chart')
@auth_required
def chart():
    return render_template('chart.html')

@app.route('/orderhistory')
@auth_required
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
@auth_required
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
@auth_required
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

@app.route('/api/trade', methods=['POST'])
def trade():
    if not request.is_json:
        return jsonify({"success": False, "message": "Request must be JSON"}), 400
        
    data = request.get_json()
    required_fields = ['symbol', 'quantity', 'type']
    
    # Validate required fields
    for field in required_fields:
        if field not in data:
            return jsonify({"success": False, "message": f"Missing required field: {field}"}), 400
            
    # Validate trade type
    if data['type'].upper() not in ['BUY', 'SELL']:
        return jsonify({"success": False, "message": "Invalid trade type. Must be 'BUY' or 'SELL'"}), 400
        
    # Check market hours
    if not is_market_open():
        return jsonify({
            "success": False, 
            "message": "Market is currently closed. Trades can only be executed during market hours (9:30 AM - 4:00 PM EST, Monday-Friday)"
        }), 400
        
    try:
        # Get user_id from session or request headers
        user_id = request.headers.get('X-User-ID')
        if not user_id:
            return jsonify({"success": False, "message": "User not authenticated"}), 401
            
        result = execute_trade(
            user_id,
            data['symbol'].upper(),
            float(data['quantity']),
            data['type'].upper() == 'BUY'
        )
        
        if result['success']:
            return jsonify(result), 200
        else:
            return jsonify(result), 400
            
    except ValueError as e:
        return jsonify({"success": False, "message": f"Invalid quantity: {str(e)}"}), 400
    except Exception as e:
        return jsonify({"success": False, "message": f"Server error: {str(e)}"}), 500

@app.route('/api/holdings', methods=['GET'])
def get_holdings():
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

# Serve static files
@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=True)
