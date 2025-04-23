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
  host: process.env.PGHOST,
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

// ----------------------------------   API ENDPOINT TO FINNHUB FOR LOADMORE   ----------------------------------

app.get('/api/news', async (req, res) => {
  try {
    const apiKey  = process.env.FINNHUB_API_KEY;
    const offset  = parseInt(req.query.offset, 10) || 0;
    const keyword = (req.query.keyword || '').trim().toLowerCase();
    const pageSize = 10;

    // 1) Fetch “general” news from Finnhub
    const url = `https://finnhub.io/api/v1/news?category=general&token=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Finnhub returned ${response.status}`);
    const raw = await response.json();              // raw is an array

    // 2) Map Finnhub’s shape → ours
    let feed = raw.map(item => ({
      title:          item.headline,
      summary:        item.summary || '',
      url:            item.url,
      time_published: new Date(item.datetime * 1000).toLocaleString()
    }));

    // 3) Keyword filter
    if (keyword) {
      feed = feed.filter(n =>
        n.title.toLowerCase().includes(keyword) ||
        n.summary.toLowerCase().includes(keyword)
      );
    }

    // 4) Pagination
    const totalItems    = feed.length;
    const paginated     = feed.slice(offset, offset + pageSize);
    const nextOffset    = offset + pageSize;
    const hasMore       = nextOffset < totalItems;

    // Always return JSON for your front‐end “Load More”:
    return res.json({
      news:       paginated,
      nextOffset,
      hasMore
    });

  } catch (err) {
    console.error('API News Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

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
  res.render('pages/login', {showHeader: false});
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
      return res.render('pages/login', { message: "Incorrect username or password." }, {showHeader: false});
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
  res.render('pages/register', {showHeader: false});
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
  res.render('pages/discover', { username: req.session.user.username, showHeader: true});
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
    symbol: symbol, // Pass symbol to pre-fill input
    showHeader: true
  });
});

//discover route
app.get('/discover', (req, res) => {
  res.render('pages/discover', {showHeader: true});
});

app.get('/home', (req, res) => {
  res.render('pages/home', {showHeader: true});
});

//getTopStocks for leaderboard
async function getTopStocks(limit = 100) {
  try {
    console.log(`Requesting top ${limit} stocks from API...`);
    const response = await fetch('https://flask-api-nhm2.onrender.com/api/top_stocks?limit=' + limit);
    
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
      lastUpdated: new Date().toLocaleString(),
      showHeader: true
    });
    
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.render('pages/leaderboard', { 
      error: 'Failed to load stock data',
      stocks: [],
      lastUpdated: 'Never',
      showHeader: true
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
    res.render('pages/portfolio', {...portfolioData, showHeader: true});
  } catch (err) {
    console.error('Error retrieving portfolio data:', err);
    res.status(500).send('Internal Server Error');
  }
});

// news page route using Finnhub API
app.get('/news', async (req, res) => {
  try {
    const apiKey = process.env.FINNHUB_API_KEY;
    // Finnhub “general” news endpoint
    const url = `https://finnhub.io/api/v1/news?category=general&token=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch news from Finnhub (${response.status})`);
    }
    const newsData = await response.json();
    // Finnhub returns an array of { headline, summary, url, datetime, source, image }
    let feed = Array.isArray(newsData) ? newsData : [];

    // map to your existing shape
    feed = feed.map(item => ({
      title: item.headline,
      summary: item.summary || '',
      url: item.url,
      // convert Unix secs → ISO string for Handlebars
      time_published: new Date(item.datetime * 1000).toLocaleString()
    }));

    // keyword filter
    const keyword = req.query.keyword ? req.query.keyword.trim() : '';
    if (keyword) {
      const kw = keyword.toLowerCase();
      feed = feed.filter(item =>
        item.title.toLowerCase().includes(kw) ||
        item.summary.toLowerCase().includes(kw)
      );
    }

    // paginate
    const totalItems = feed.length;
    const offset     = parseInt(req.query.offset, 10) || 0;
    const pageSize   = 10;
    const paginated  = feed.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    const hasMore    = nextOffset < totalItems;

    const pullTimestamp = new Date().toLocaleString();

    // render exactly as before
    res.render('pages/news', {
      news:     { feed: paginated },
      pulledAt: pullTimestamp,
      keyword,
      nextOffset,
      hasMore,
      showHeader: true
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
    user: req.session.user,
    showHeader: true
  });
});

// settings route
app.get('/settings', auth, (req, res) => {
  res.render('pages/settings', {
    user: req.session.user,
    showHeader: true
  });
});

app.post('/settings', auth, async (req, res) => {
  const { username, email, password } = req.body;
  const userId = req.session.user.user_id;

  try {
    const updates = [];
    const params  = [];

    if (username && username.trim()) {
      params.push(username.trim());
      updates.push(`username = $${params.length}`);
    }
    if (email && email.trim()) {
      params.push(email.trim());
      updates.push(`email = $${params.length}`);
    }
    if (password && password.trim()) {
      const hash = await bcrypt.hash(password.trim(), 10);
      params.push(hash);
      updates.push(`password_hash = $${params.length}`);
    }

    if (updates.length) {
      // build query only for provided fields
      const query = `
        UPDATE users
        SET ${updates.join(', ')}
        WHERE user_id = $${params.length + 1}
      `;
      params.push(userId);
      await db.none(query, params);

      // reflect changes in session
      if (username && username.trim()) req.session.user.username = username.trim();
      if (email && email.trim())    req.session.user.email    = email.trim();
    }

    res.render('pages/settings', {
      user: req.session.user,
      success: true,
      showHeader: true
    });

  } catch (err) {
    console.error('Settings update error:', err);
    res.render('pages/settings', {
      user: req.session.user,
      error: 'Failed to save changes. Please try again.',
      showHeader: true
    });
  }
});

// *****************************************************
// <!-- Start Server-->
// *****************************************************
// starting the server and keeping the connection open to listen for more requests
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  // Wake up Flask API server
  (async () => {
    try {
      const res = await fetch(`https://flask-api-nhm2.onrender.com/api/market-status`);
      if (res.ok) {
        console.log('✅ Flask API woke up successfully');
      } else {
        console.warn(`⚠️ Flask API wake-up ping returned ${res.status} [500 = Market Closed]`);
      }
    } catch (err) {
      console.error('❌ Error pinging Flask API to wake it up:', err.message);
    }
  })();
});
