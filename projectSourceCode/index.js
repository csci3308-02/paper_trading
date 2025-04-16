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

// Configure API proxy with increased timeouts and logging
const apiProxy = createProxyMiddleware({
  target: 'http://api:8000',
  changeOrigin: true,
  timeout: 60000, // 60 second timeout
  proxyTimeout: 60000, // 60 second proxy timeout
  logLevel: 'debug', // Add debug logging
  onProxyReq: (proxyReq, req, res) => {
    console.log(`[Proxy Request] ${req.method} ${req.originalUrl}`);
    // Handle POST request body rewriting
    if (req.body && req.method === 'POST') {
      const bodyData = JSON.stringify(req.body);
      // Update headers
      proxyReq.setHeader('Content-Type', 'application/json');
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      // Write body data
      proxyReq.write(bodyData);
      console.log('[Proxy Request Body]', bodyData);
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    console.log(`[Proxy Response] ${proxyRes.statusCode} ${req.method} ${req.originalUrl}`);
    // Log response body for debugging
    let responseBody = '';
    proxyRes.on('data', function(chunk) {
      responseBody += chunk;
    });
    proxyRes.on('end', function() {
      console.log('[Proxy Response Body]', responseBody);
    });
  },
  onError: (err, req, res) => {
    console.error('[Proxy Error]:', err);
    res.status(500).json({
      error: 'API Service Temporarily Unavailable',
      details: err.message,
      path: req.originalUrl
    });
  }
});

// Apply proxy middleware to all /api routes
app.use('/api', apiProxy);

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


// ----------------------------------   API ENDPOINT TO ALPHAVANTAGE FOR LOADMORE   ----------------------------------

app.get('/api/news', async (req, res) => {
  try {
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&apikey=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(500).json({ error: 'Failed to fetch news.' });
    }
    const newsData = await response.json();
    let feed = Array.isArray(newsData.feed) ? newsData.feed : [];

    const keyword = req.query.keyword ? req.query.keyword.trim() : '';
    const offset = parseInt(req.query.offset, 10) || 0;

    if (keyword) {
      feed = feed.filter(item => {
         const title = item.title ? item.title.toLowerCase() : "";
         const summary = item.summary ? item.summary.toLowerCase() : "";
         return title.includes(keyword.toLowerCase()) || summary.includes(keyword.toLowerCase());
      });
    }
    
    const totalItems = feed.length;
    const paginatedNews = feed.slice(offset, offset + 10).map(item => {
      if (item.time_published && typeof item.time_published === 'string' && item.time_published.length >= 15) {
        const isoStr = item.time_published.slice(0, 4) + '-' +
                       item.time_published.slice(4, 6) + '-' +
                       item.time_published.slice(6, 8) + 'T' +
                       item.time_published.slice(9, 11) + ':' +
                       item.time_published.slice(11, 13) + ':' +
                       item.time_published.slice(13, 15);
        item.time_published = new Date(isoStr).toLocaleString();
      }
      return item;
    });
    
    const nextOffset = offset + 10;
    const hasMore = nextOffset < totalItems;
    
    res.json({ news: paginatedNews, nextOffset, hasMore });
  } catch (error) {
    console.error('API News Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ----------------------------------   API PROXY TO PYTHON SERVER   ----------------------------------

app.use('/api', createProxyMiddleware({
  target: 'http://api:8000',
  changeOrigin: true,
  onProxyReq: (proxyReq, req, res) => {
    // Forward the user ID from session to the Python API
    if (req.session.user) {
      proxyReq.setHeader('X-User-ID', req.session.user.user_id);
    }
  }
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
      "INSERT INTO users (username, email, password_hash, balance) VALUES ($1, $2, $3, $4)",
      [username, email, hashedPassword, 10000.00]
    );
    res.redirect('/login');
  } catch (error) {
    console.error('Registration error:', error);
    res.redirect('/register');
  }
});

// API route for Order History Page
app.get('/orderhistory', async (req, res) => {
  if (!req.session.user) {
      return res.redirect('/login');
  }

  try {
      const orders = await db.any(
          'SELECT s.company_name as stock_name, s.symbol, t.price, t.quantity, t.transaction_type as type, t.transaction_date as created_at FROM transactions t JOIN stocks s ON t.stock_id = s.stock_id WHERE t.user_id = $1 ORDER BY t.transaction_date DESC',
          [req.session.user.user_id]
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

// news page route using AlphaVantage API
app.get('/news', async (req, res) => {
  try {
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&apikey=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Failed to fetch news from Alphavantage.');
    }
    const newsData = await response.json();
    let feed = Array.isArray(newsData.feed) ? newsData.feed : [];
    
    // search bar
    const keyword = req.query.keyword ? req.query.keyword.trim() : '';
    
    if (keyword) {
      feed = feed.filter(item => {
        const title = item.title ? item.title.toLowerCase() : "";
        const summary = item.summary ? item.summary.toLowerCase() : "";
        return title.includes(keyword.toLowerCase()) || summary.includes(keyword.toLowerCase());
      });
    }
    
    // reformat dates and get at most 10 items at a time
    const totalItems = feed.length;
    let paginatedNews = feed.slice(0, 10).map(item => {
      if (item.time_published && typeof item.time_published === 'string' && item.time_published.length >= 15) {
        const isoStr = item.time_published.slice(0, 4) + '-' +
                       item.time_published.slice(4, 6) + '-' +
                       item.time_published.slice(6, 8) + 'T' +
                       item.time_published.slice(9, 11) + ':' +
                       item.time_published.slice(11, 13) + ':' +
                       item.time_published.slice(13, 15);
        item.time_published = new Date(isoStr).toLocaleString();
      }
      return item;
    });
    // info for load more
    const nextOffset = 10;
    const hasMore = nextOffset < totalItems;
    // record when news was pulled
    const pullTimestamp = new Date().toLocaleString();
    
    res.render('pages/news', {
      news: { feed: paginatedNews },
      pulledAt: pullTimestamp,
      keyword,
      nextOffset,
      hasMore
    });
    
  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/trade', auth, (req, res) => {
  const symbol = req.query.symbol || '';
  res.render('pages/trade', { 
    symbol,
    user: req.session.user
  });
});

// *****************************************************
// <!-- Start Server-->
// *****************************************************
// starting the server and keeping the connection open to listen for more requests
app.listen(3000, () => {
  console.log('Server is running at http://localhost:3000');
});