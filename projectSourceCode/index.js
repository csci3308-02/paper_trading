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
const fetch1 = require('node-fetch');
const app = express();

// ----------------------------------   STATIC FILES   ----------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------   VIEW ENGINE SETUP   ------------------------------------------

const hbs = handlebars.create({
  extname: 'hbs',
  layoutsDir: path.join(__dirname, 'views/layouts'),
  partialsDir: path.join(__dirname, 'views/partials'),
  defaultLayout: 'main',
  helpers: {
    // Comparison helpers
    gt: (a, b) => a > b,
    lt: (a, b) => a < b,
    gte: (a, b) => a >= b,
    lte: (a, b) => a <= b,
    eq: (a, b) => a === b,
    // Math helpers
    add: (a, b) => a + b,
    subtract: (a, b) => a - b,
    // Formatting
    formatPrice: (price) => '$' + parseFloat(price || 0).toFixed(2),
    formatChange: (change) => parseFloat(change || 0).toFixed(2) + '%'
  }
});

app.engine('hbs', hbs.engine);
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

// ----------------------------------   MIDDLEWARE   --------------------------------------------------

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

// ----------------------------------   API ENDPOINT FOR SEARCH   ----------------------------------

app.use('/api/search', createProxyMiddleware({
  target: 'https://flask-api-nhm2.onrender.com',
  changeOrigin: true,
  secure: true,
  pathRewrite: {
    '^/api/search': '/api/search' // Ensure path is preserved
  },
  onProxyReq: (proxyReq, req, res) => {
    console.log(`Proxying request: ${req.originalUrl}`) // Debug logging
  }
}));

// ----------------------------------   API PROXY TO PYTHON SERVER   ----------------------------------

app.use('/api', createProxyMiddleware({
  target: 'https://flask-api-nhm2.onrender.com',
  changeOrigin: true,
  secure: true,
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
    res.status(500).render('pages/login', { message: "Account does not exist. Please register below!" });
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

app.get('/discover', auth, (req, res) => {
  res.render('pages/discover', { username: req.session.user.username });
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

//getTopStocks for leaderboard
async function getTopStocks(limit = 100) {
  try {
    console.log(`Requesting top ${limit} stocks from API...`);
    const response = await fetch('http://api:8000/api/top_stocks?limit=' + limit);
    
    if (!response.ok) {
      throw new Error(`API returned status: ${response.status}`);
    }
    
    const stocks = await response.json();
    console.log(`Retrieved ${stocks.length} stocks from API`);
    return stocks;
  } catch (error) {
    console.error('Error fetching top stocks:', error);
    
    // Fallback to database if API fails
    console.log('Falling back to database for stocks'); //querry database for stock info
    return await db.any(`
      SELECT 
        symbol,
        company_name AS company,
        last_price AS last_price,
        0 AS change
      FROM stocks
      ORDER BY last_price DESC
      LIMIT $1
    `, [limit]);
  }
}

// Updated leaderboard route
app.get('/leaderboard', auth, async (req, res) => {
  try {
    // Explicitly request 100 stocks
    const stocks = await getTopStocks(100);
    console.log(`Fetched ${stocks.length} stocks for leaderboard`);
    
    if (stocks.length === 0) {
      console.warn('No stocks returned from API or database!');
    }
    
    // Process and filter stocks - remove any with price of 0
    const processedStocks = stocks
      .filter(stock => {
        const price = parseFloat(stock.last_price || stock.price || 0);
        return price > 0; // Only include stocks with price > 0
      })
      .map((stock, index) => ({
        rank: index + 1,
        company: stock.company,
        symbol: stock.symbol,
        price: parseFloat(stock.last_price || stock.price || 0),
        change: parseFloat(stock.change || 0),
        isTopThree: index < 3,
        isPositive: parseFloat(stock.change || 0) > 0
      }));

    res.render('pages/leaderboard', { 
      stocks: processedStocks,
      lastUpdated: new Date().toLocaleString()
    });
    
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.render('pages/leaderboard', { 
      error: 'Failed to load stock data',
      stocks: [],
      lastUpdated: 'Never'
    });
  }
});

// portfolio calculator/controller
async function getPortfolioData(userId) {
  try {
    // 1) Get user info
    const userResult = await db.one(
      `SELECT user_id, username, email, balance, created_at
       FROM users
       WHERE user_id = $1`,
      [userId]
    );
    const user = userResult;

    // 2) Get holdings + live prices
    const holdingsResult = await db.any(
      `SELECT h.quantity, s.symbol, s.company_name, s.last_price
       FROM holdings h
       JOIN stocks s ON h.stock_id = s.stock_id
       WHERE h.user_id = $1`,
      [userId]
    );
    // Refresh live price for each holding
    for (let holding of holdingsResult) {
      try {
        // call your live‐price endpoint:
        const res = await fetch(`http://api:8000/api/price/${holding.symbol}`);
        if (res.ok) {
          const { price } = await res.json();
          holding.last_price = price;
        }
      } catch (err) {
        console.error(`Failed live price update for ${holding.symbol}:`, err);
      }
    }

    // 3) Compute total value of current holdings
    const holdingsValue = holdingsResult.reduce(
      (sum, h) => sum + parseFloat(h.quantity) * parseFloat(h.last_price),
      0
    );

    // 4) Pull all transactions (for display) and also ordered‐asc for FIFO stats
    const transactionsDisplay = await db.any(
      `SELECT t.transaction_date, t.transaction_type, t.quantity, t.price, s.symbol
       FROM transactions t
       JOIN stocks s ON t.stock_id = s.stock_id
       WHERE t.user_id = $1
       ORDER BY t.transaction_date DESC`,
      [userId]
    );
    const transactionsStats = await db.any(
      `SELECT t.transaction_date, t.transaction_type, t.quantity, t.price, s.symbol
       FROM transactions t
       JOIN stocks s ON t.stock_id = s.stock_id
       WHERE t.user_id = $1
       ORDER BY t.transaction_date ASC`,
      [userId]
    );

    // 5) Compute realized profit & FIFO matching
    let stats = {
      totalProfit: 0,
      totalTrades: 0,
      winningTrades: 0,
      biggestWin: -Infinity,
      biggestLoss: Infinity
    };
    const buyQueues = {};

    for (const tx of transactionsStats) {
      const sym = tx.symbol;
      const qty = parseFloat(tx.quantity);
      const prc = parseFloat(tx.price);
      if (!buyQueues[sym]) buyQueues[sym] = [];

      if (tx.transaction_type === 'BUY') {
        buyQueues[sym].push({ quantity: qty, price: prc });
      } else {
        let remaining = qty, tradeProfit = 0;
        while (remaining > 0 && buyQueues[sym].length) {
          const head = buyQueues[sym][0];
          const used = Math.min(remaining, head.quantity);
          tradeProfit += used * (prc - head.price);
          head.quantity -= used;
          remaining -= used;
          if (head.quantity <= 0) buyQueues[sym].shift();
        }
        stats.totalTrades++;
        stats.totalProfit += tradeProfit;
        if (tradeProfit > 0) stats.winningTrades++;
        stats.biggestWin = Math.max(stats.biggestWin, tradeProfit);
        stats.biggestLoss = Math.min(stats.biggestLoss, tradeProfit);
      }
    }

    // 6) Compute summary statistics
    const averageReturn = stats.totalTrades
      ? stats.totalProfit / stats.totalTrades
      : 0;
    const winRate = stats.totalTrades
      ? (stats.winningTrades / stats.totalTrades) * 100
      : 0;
    if (stats.biggestWin === -Infinity) stats.biggestWin = 0;
    if (stats.biggestLoss === Infinity) stats.biggestLoss = 0;

    // 7) Total return = (current balance + holdings value) – initial investment
    const initialInvestment = 10000; 
    const totalReturn =
      parseFloat(user.balance) + holdingsValue - initialInvestment;

    const statistics = {
      totalReturn: totalReturn.toFixed(2),
      winRate: winRate.toFixed(2),
      averageReturn: averageReturn.toFixed(2),
      biggestLoss: stats.biggestLoss.toFixed(2),
      biggestWin: stats.biggestWin.toFixed(2)
    };

    // 8) Return everything—including realized profit for {{profit}}
    return {
      user,
      balance: user.balance,
      profit: stats.totalProfit.toFixed(2),
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
