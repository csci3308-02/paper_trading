from flask import Flask, render_template, request, redirect, url_for, session, jsonify
from flask_cors import CORS
from models import Base, User, Stock, Holding, Transaction
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import os
from datetime import datetime, timezone
import bcrypt
import uuid
from buy_sell import execute_trade, is_market_open

app = Flask(__name__)
CORS(app)
app.secret_key = os.getenv('SESSION_SECRET', 'your-secret-key')

# Database setup
engine = create_engine(f"postgresql://{os.getenv('POSTGRES_USER')}:{os.getenv('POSTGRES_PASSWORD')}@db/{os.getenv('POSTGRES_DB')}")
Session = sessionmaker(bind=engine)

# Auth middleware
def auth_required(f):
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    decorated.__name__ = f.__name__
    return decorated

@app.route('/')
def index():
    if 'user_id' in session:
        return redirect(url_for('discover'))
    return redirect(url_for('login'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        db_session = Session()
        try:
            user = db_session.query(User).filter(User.username == request.form['username']).first()
            if user and bcrypt.checkpw(request.form['password'].encode('utf-8'), user.password_hash.encode('utf-8')):
                session['user_id'] = str(user.user_id)
                return redirect(url_for('discover'))
            return render_template('login.html', error='Invalid username or password')
        finally:
            db_session.close()
    return render_template('login.html')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        db_session = Session()
        try:
            hashed_password = bcrypt.hashpw(request.form['password'].encode('utf-8'), bcrypt.gensalt())
            user = User(
                username=request.form['username'],
                email=request.form['email'],
                password_hash=hashed_password.decode('utf-8'),
                balance=10000.00
            )
            db_session.add(user)
            db_session.commit()
            return redirect(url_for('login'))
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
        return jsonify({"success": False, "message": f"Error fetching recent trades: {str(e)}"}), 500
    finally:
        session.close()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=True)
