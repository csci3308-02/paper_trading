// ----------------------------------   DEPENDENCIES  ----------------------------------------------
require('dotenv').config();
const express = require('express');
const path = require('path');
const handlebars = require('express-handlebars');
const pgp = require('pg-promise')();
const session = require('express-session');
const bodyParser = require('body-parser');
const { createProxyMiddleware } = require('http-proxy-middleware');

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
  target: 'http://python:5000',
  changeOrigin: true,
  pathRewrite: { '^/api': '' },
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



app.get('/login', (req, res) => {
  res.render('pages/login');
});


// Login submission
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err || !user) {
      return res.redirect('/register');
    }

    try {
      const match = await bcrypt.compare(password, user.password);
      if (!match) {
        return res.render('login', { message: "Incorrect username or password." });
      }

      req.session.user = user;
      req.session.save(() => {
        res.redirect('/discover');
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).render('login', { message: "Something went wrong. Please try again later." });
    }
  });
});

app.get('/register', (req, res) => {
  res.render('pages/register');
});

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  try {
      const hashedPassword = await bcrypt.hash(password, 10);
      db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hashedPassword], function (err) {
          if (err) {
              return res.redirect('/register');
          }
          res.redirect('/login');
      });
  } catch (error) {
      res.redirect('/register');
  }
});
  
 // Chart page (no auth required)
app.get('/chart', (req, res) => {
  res.render('pages/chart');
});

app.use(auth);

// -------------------------------------  ROUTES for home.hbs   ----------------------------------------------

app.get('/', (req, res) => {
  res.render('pages/home', {
    username: req.session.user.username,
    profits: req.session.user.profits,
    money_held: req.session.user.moneyHeld,
    money_in_stocks: req.session.user.moneyInStocks,
  });
});




// -------------------------------------  ROUTES for logout.hbs   ----------------------------------------------

app.get('/logout', (req, res) => {
  req.session.destroy(function(err) {
    res.render('pages/logout');
  });
});

// -------------------------------------  START THE SERVER   ----------------------------------------------

app.listen(3000, () => {
  console.log('Server is running at http://localhost:3000');
});

