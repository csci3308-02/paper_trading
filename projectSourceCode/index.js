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

db.connect()
  .then(obj => {
    console.log('Database connection successful');
    obj.done();
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
app.get('/login', (req, res) => {
  res.render('pages/login');
});

// Login form submission
app.post('/login', (req, res) => {
  const username = req.body.username;
  const query = 'SELECT * FROM users WHERE username = $1 LIMIT 1';

  db.one(query, [username])
    .then(data => {
      req.session.user = {
        username: data.username,
        profits: data.profits,
        moneyHeld: data.moneyheld,
        moneyInStocks: data.moneyinstocks,
      };
      res.redirect('/');
    })
    .catch(err => {
      console.log(err);
      res.redirect('/login');
    });
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.render('pages/logout'));
});

// Chart page (no auth required)
app.get('/chart', (req, res) => {
  res.render('pages/chart');
});

// Home page (auth required)
app.get('/', auth, (req, res) => {
  res.render('pages/home', {
    username: req.session.user.username,
    profits: req.session.user.profits,
    money_held: req.session.user.moneyHeld,
    money_in_stocks: req.session.user.moneyInStocks,
  });
});

// ----------------------------------   START SERVER   ------------------------------------------------

app.listen(3000, () => {
  console.log('Server is running at http://localhost:3000');
});
