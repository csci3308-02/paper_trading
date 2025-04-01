//Import Dependencies
require('dotenv').config();
const express = require('express'); // To build an application server or API
const app = express();
const handlebars = require('express-handlebars');
const Handlebars = require('handlebars');
const path = require('path');
const pgp = require('pg-promise')(); // To connect to the Postgres DB from the node server
const bodyParser = require('body-parser');
const session = require('express-session'); // To set the session object. To store or access session data, use the `req.session`, which is (generally) serialized as JSON by the store.
const bcrypt = require('bcryptjs'); //  To hash passwords
const axios = require('axios'); // To make HTTP requests from our server.
const cors = require('cors');
const yahooFinance = require('yahoo-finance2').default;


const PORT = process.env.PORT || 3000; // double check this*****


//TODO!!! connect to DB 
//handlebars   
const hbs = handlebars.create({
    extname: 'hbs',
    layoutsDir: __dirname + '/views/layouts',
    partialsDir: __dirname + '/views/partials',
  });

// database configuration
const dbConfig = {
    host: 'db', // the database server
    port: 5432, // the database port
    database: process.env.POSTGRES_DB, // the database name
    user: process.env.POSTGRES_USER, // the user account to connect with
    password: process.env.POSTGRES_PASSWORD, // the password of the user account
  };

  const db = pgp(dbConfig);

// test your database
db.connect()
  .then(obj => {
    console.log('Database connection successful'); // you can view this message in the docker compose logs
    obj.done(); // success, release the connection;
  })
  .catch(error => {
    console.log('ERROR:', error.message || error);
  });


// *****************************************************
// <!-- App Settings -->
// *****************************************************
// Register `hbs` as our view engine using its bound `engine()` function.
app.engine('hbs', hbs.engine);
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.json()); // specify the usage of JSON for parsing request body.

// initialize session variables
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    saveUninitialized: false,
    resave: false,
  })
);

app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);
// Middleware ............ Do i need these lines? *******
app.use(cors());
app.use(express.json());

// API Keys
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

// Cache setup
const cache = new Map();
const CACHE_DURATION = 60000; // 1 minute

// Helper function to fetch from yfinance
async function fetchYahooData(symbol, interval = '5m') {
  try {
    const result = await yahooFinance.chart(symbol, { interval });
    return {
      success: true,
      data: result
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Helper function to fetch from Alpha Vantage
async function fetchAlphaVantageData(symbol, functionType = 'TIME_SERIES_INTRADAY') {
  try {
    const response = await axios.get('https://www.alphavantage.co/query', {
      params: {
        function: functionType,
        symbol: symbol,
        interval: '5min',
        apikey: ALPHA_VANTAGE_API_KEY,
        outputsize: 'compact'
      }
    });

    if (response.data['Error Message']) {
      throw new Error(response.data['Error Message']);
    }

    return {
      success: true,
      data: response.data
    };
  } catch (error) { // if this fails should we route to the other API automatically?( to take care of running out of api calls)
    return {
      success: false,
      error: error.message 
    };
  }
}

// Hybrid data fetcher
async function getStockData(symbol) {
  const cacheKey = `stock_${symbol}`;
  
  // Check cache first
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_DURATION) {
      return cached.data;
    }
  }

  // Try yfinance first
  const yahooResult = await fetchYahooData(symbol);
  
  if (yahooResult.success) {
    const processed = processYahooData(yahooResult.data);
    cache.set(cacheKey, {
      data: processed,
      timestamp: Date.now()
    });
    return processed;
  }

  // Fallback to Alpha Vantage
  const alphaResult = await fetchAlphaVantageData(symbol);
  
  if (alphaResult.success) {
    const processed = processAlphaVantageData(alphaResult.data);
    cache.set(cacheKey, {
      data: processed,
      timestamp: Date.now()
    });
    return processed;
  }

  throw new Error(`Failed to fetch data for ${symbol} from all sources`);
}

// Data processors
function processYahooData(data) {
  const quotes = data.quotes || [];
  return {
    meta: {
      symbol: data.meta.symbol,
      currency: data.meta.currency,
      exchangeName: data.meta.exchangeName
    },
    quotes: quotes.map(q => ({
      time: new Date(q.date).toISOString(),
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume
    })),
    currentPrice: quotes.length > 0 ? quotes[quotes.length - 1].close : null,
    source: 'yahoo'
  };
}

function processAlphaVantageData(data) {
  const timeSeries = data['Time Series (5min)'] || {};
  const times = Object.keys(timeSeries).sort();
  return {
    meta: {
      symbol: data['Meta Data']['2. Symbol'],
      information: data['Meta Data']['1. Information']
    },
    quotes: times.map(time => ({
      time,
      open: parseFloat(timeSeries[time]['1. open']),
      high: parseFloat(timeSeries[time]['2. high']),
      low: parseFloat(timeSeries[time]['3. low']),
      close: parseFloat(timeSeries[time]['4. close']),
      volume: parseInt(timeSeries[time]['5. volume'])
    })),
    currentPrice: times.length > 0 ? parseFloat(timeSeries[times[times.length - 1]]['4. close']) : null,
    source: 'alpha-vantage'
  };
}

// News fetcher (Alpha Vantage only)
async function getStockNews(symbol) {
  const cacheKey = `news_${symbol}`;
  
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_DURATION * 10) { // 10 min cache for news
      return cached.data;
    }
  }

  try {
    const response = await axios.get('https://www.alphavantage.co/query', {
      params: {
        function: 'NEWS_SENTIMENT',
        tickers: symbol,
        apikey: ALPHA_VANTAGE_API_KEY,
        limit: 10 // Max articles to return
      }
    });

    if (response.data.feed) {
      const processed = response.data.feed.map(article => ({
        title: article.title,
        url: article.url,
        summary: article.summary,
        source: article.source,
        time: article.time_published,
        sentiment: article.overall_sentiment_score
      }));
      
      cache.set(cacheKey, {
        data: processed,
        timestamp: Date.now()
      });
      
      return processed;
    }
    
    throw new Error('No news data available');
  } catch (error) {
    console.error('Error fetching news:', error.message);
    return [];
  }
}

// API Endpoints
app.get('/api/stock/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const data = await getStockData(symbol);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stock/:symbol/news', async (req, res) => {
  try {
    const { symbol } = req.params;
    const news = await getStockNews(symbol);
    res.json(news);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/search/:query', async (req, res) => {
  try {
    const { query } = req.params;
    // Use Yahoo for search
    const results = await yahooFinance.search(query);
    res.json(results.quotes || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// *****************************************************
// <!-- Start Server-->
// *****************************************************
// starting the server and keeping the connection open to listen for more requests
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});