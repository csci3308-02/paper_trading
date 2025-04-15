// ----------------------------------   DEPENDENCIES  ----------------------------------------------
require('dotenv').config();
const express = require('express');
const path = require('path');
const handlebars = require('express-handlebars');
const pgp = require('pg-promise')();
const session = require('express-session');
const bodyParser = require('body-parser');
const { createProxyMiddleware } = require('http-proxy-middleware');
const bcrypt = require('bcrypt');

const app = express();

// ----------------------------------   STATIC FILES   ----------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------   VIEW ENGINE SETUP   ------------------------------------------

const hbs = handlebars.create({
  extname: 'hbs',
  layoutsDir: path.join(__dirname, 'views/layouts'),
  partialsDir: path.join(__dirname, 'views/partials'),
  defaultLayout: 'main',
});

app.engine('hbs', hbs.engine);
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

// ----------------------------------   MIDDLEWARE   --------------------------------------------------

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
  })
);

// Make session user available in all views
app.use((req, res, next) => {
  res.locals.user = req.session.user;
  next();
});

// ----------------------------------   DB CONFIG   ---------------------------------------------------

const dbConfig = {
  host: 'db',
  port: 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
};
const db = pgp(dbConfig);


// db test
db.connect()
  .then(obj => {
    // Can check the server version here (pg-promise v10.1.0+):
    console.log('Database connection successful');
    obj.done(); // success, release the connection;
  })
  .catch(error => {
    console.log('ERROR', error.message || error);
  });


// ----------------------------------   API PROXY TO PYTHON SERVER   ----------------------------------

app.use('/api', createProxyMiddleware({
  target: 'http://api:8000',
  changeOrigin: true
}));

// ----------------------------------   ROUTES   ------------------------------------------------------

// Auth middleware
const auth = (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
};

// Login page
// -------------------------------------  ROUTES for login.hbs   ----------------------------------------------
const user = {
  username: undefined,
  profits: undefined,
  moneyHeld: undefined,
  moneyInStocks: undefined,
};

app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/discover');
  } else {
    return res.redirect('/login');
  }
});


app.get('/login', (req, res) => {
  res.render('pages/login');
});


// Login submission
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await db.one("SELECT * FROM users WHERE username = $1", [username]);
    
    if (!user) {
      return res.redirect('/register');
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.render('pages/login', { message: "Incorrect username or password." });
    }

    req.session.user = user;
    req.session.save(() => {
      res.redirect('/discover');
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).render('pages/login', { message: "Something went wrong. Please try again later." });
  }
});

app.get('/register', (req, res) => {
  res.render('pages/register');
});

app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await db.none(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)",
      [username, email, hashedPassword]
    );
    res.redirect('/login');
  } catch (error) {
    console.error('Registration error:', error);
    res.redirect('/register');
  }
});

app.use('/api/search', createProxyMiddleware({
  target: 'http://api:8000',
  changeOrigin: true,
  pathRewrite: {
    '^/api/search': '/api/search' // Ensure path is preserved
  },
  onProxyReq: (proxyReq, req, res) => {
    console.log(`Proxying request: ${req.originalUrl}`) // Debug logging
  }
}));



// API route for Order History Page
app.get('/orderhistory', async (req, res) => {
  if (!req.session.user) {
      return res.redirect('/login'); // Redirect if not logged in !! create login API
  }

  try {
      const orders = await db.any(
          'SELECT stock_name, symbol, price, quantity, type, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC', // sample query can change depending on info needed
          [req.session.user.id]
      );
      res.render('pages/orderhistory', { orders });
  } catch (error) {
      console.error('Error fetching order history:', error);
      res.status(500).send('Internal Server Error');
  }
});

app.get('/discover', auth, (req, res) => {
  res.render('pages/discover'); 
});

app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Logout error:", err);
    }
    res.redirect('/login');
  });
});

// Add API endpoint for historical data Havent tested maybe remove
app.get('/api/history', async (req, res) => {
  const { ticker, period, interval } = req.query;
  try {
    // Replace this with your actual data-fetching logic (e.g., Yahoo Finance API)
    const mockData = [
      { time: "2024-01-01T09:30:00", price: 150.00 },
      { time: "2024-01-01T10:00:00", price: 152.50 },
      // ... more data points
    ];
    res.json(mockData);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch historical data" });
  }
});


// chart route
app.get('/chart', (req, res) => {
  const symbol = req.query.symbol || ''; // Get symbol from URL (e.g., /chart?symbol=AAPL)
  res.render('pages/chart', { 
    title: `${symbol || 'Stock'} Chart`, 
    symbol: symbol // Pass symbol to pre-fill input
  });
});

//discover route
app.get('/discover', (req, res) => {
  res.render('pages/discover');
});

app.get('/home', (req, res) => {
  res.render('pages/home');
});

// Or if using API data:
app.get('/leaderboard', async (req, res) => {
  try {
    const leaderboardData = await getLeaderboardData(); // Your data function
    res.render('pages/leaderboard', { data: leaderboardData });
  } catch (error) {
    res.status(500).send("Error loading leaderboard");
  }
});

// portfolio calculator/controller
async function getPortfolioData(userId) {
  try {
    // Retrieve user information.
    const userResult = await db.one(
      'SELECT user_id, username, email, balance, created_at FROM users WHERE user_id = $1',
      [userId]
    );
    const user = userResult;

    // Retrieve holdings and join with stock details.
    const holdingsResult = await db.any(
      `SELECT h.quantity, s.symbol, s.company_name, s.last_price 
       FROM holdings h 
       JOIN stocks s ON h.stock_id = s.stock_id
       WHERE h.user_id = $1`,
      [userId]
    );

    // Calculate the total value of holdings.
    const holdingsValue = holdingsResult.reduce((acc, holding) => {
      return acc + parseFloat(holding.quantity) * parseFloat(holding.last_price);
    }, 0);

    // Retrieve transactions for display (ordered descending).
    const transactionsDisplay = await db.any(
      `SELECT t.transaction_date, t.transaction_type, t.quantity, t.price, s.symbol
       FROM transactions t
       JOIN stocks s ON t.stock_id = s.stock_id
       WHERE t.user_id = $1
       ORDER BY t.transaction_date DESC`,
      [userId]
    );

    // Retrieve transactions for statistics calculations (ordered ascending for FIFO matching).
    const transactionsStats = await db.any(
      `SELECT t.transaction_date, t.transaction_type, t.quantity, t.price, s.symbol
       FROM transactions t
       JOIN stocks s ON t.stock_id = s.stock_id
       WHERE t.user_id = $1
       ORDER BY t.transaction_date ASC`,
      [userId]
    );

    // Compute total return: current balance + current holdings value minus initial investment.
    const totalReturn = parseFloat(user.balance) + holdingsValue - 10000;

    // --- Compute trade-level statistics using FIFO matching ---
    let stats = {
      totalProfit: 0,
      totalTrades: 0,
      winningTrades: 0,
      biggestWin: -Infinity,
      biggestLoss: Infinity
    };

    // Create a buy queue for each stock symbol to implement FIFO matching.
    let buyQueues = {};

    for (let transaction of transactionsStats) {
      const symbol = transaction.symbol;
      const type = transaction.transaction_type;
      const quantity = parseFloat(transaction.quantity);
      const price = parseFloat(transaction.price);

      // Initialize queue for the stock if it doesn't exist.
      if (!buyQueues[symbol]) {
        buyQueues[symbol] = [];
      }

      if (type === 'BUY') {
        // Add buy transaction to the corresponding queue.
        buyQueues[symbol].push({ quantity, price });
      } else if (type === 'SELL') {
        let remaining = quantity;
        let tradeProfit = 0;

        // Dequeue matching BUY orders for this SELL transaction.
        while (remaining > 0 && buyQueues[symbol].length > 0) {
          let buyOrder = buyQueues[symbol][0];
          let available = buyOrder.quantity;
          let used = Math.min(remaining, available);

          // Compute profit: (sell price - buy price) * shares sold.
          tradeProfit += used * (price - buyOrder.price);
          buyOrder.quantity -= used;
          remaining -= used;

          // Remove the buy order if it has been fully matched.
          if (buyOrder.quantity <= 0) {
            buyQueues[symbol].shift();
          }
        }

        // Treat each SELL as closing one aggregated trade.
        stats.totalTrades++;
        stats.totalProfit += tradeProfit;
        if (tradeProfit > 0) {
          stats.winningTrades++;
        }
        stats.biggestWin = Math.max(stats.biggestWin, tradeProfit);
        stats.biggestLoss = Math.min(stats.biggestLoss, tradeProfit);
      }
    }

    const averageReturn = stats.totalTrades > 0 ? stats.totalProfit / stats.totalTrades : 0;
    const winRate = stats.totalTrades > 0 ? (stats.winningTrades / stats.totalTrades) * 100 : 0;
    // Handle cases where no trades were processed.
    if (stats.biggestWin === -Infinity) stats.biggestWin = 0;
    if (stats.biggestLoss === Infinity) stats.biggestLoss = 0;

    const statistics = {
      totalReturn: totalReturn.toFixed(2),
      winRate: winRate.toFixed(2),
      averageReturn: averageReturn.toFixed(2),
      biggestLoss: stats.biggestLoss.toFixed(2),
      biggestWin: stats.biggestWin.toFixed(2)
    };

    return {
      user,
      balance: user.balance,
      holdings: holdingsResult,
      transactions: transactionsDisplay,
      statistics
    };
  } catch (err) {
    console.error('Error in getPortfolioData:', err);
    throw err;
  }
}


// portfolio page route
app.get('/portfolio', auth, async (req, res) => {
  try {
    const portfolioData = await getPortfolioData(req.session.user.user_id);
    res.render('pages/portfolio', portfolioData);
  } catch (err) {
    console.error('Error retrieving portfolio data:', err);
    res.status(500).send('Internal Server Error');
  }
});


// *****************************************************
// <!-- Start Server-->
// *****************************************************
// starting the server and keeping the connection open to listen for more requests
app.listen(3000, () => {
  console.log('Server is running at http://localhost:3000');
});