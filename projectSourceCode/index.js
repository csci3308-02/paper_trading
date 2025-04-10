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

// chart route
app.get('/chart', (req, res) => {
  res.render('pages/chart');
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


// *****************************************************
// <!-- Start Server-->
// *****************************************************
// starting the server and keeping the connection open to listen for more requests
app.listen(3000, () => {
  console.log('Server is running at http://localhost:3000');
});