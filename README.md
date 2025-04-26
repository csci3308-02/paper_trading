# Stonks - StockSandbox

## Brief Application Description
When a user logs in they receive a starting balance of fake money which they can use to trade real-world stocks (prices and fluctuations pulled via an API). The app tracks their holdings, cash balance, and profit/loss over time, and provides pages for:

- **Login / Registration**  
- **Discover** (welcome page + global search)  
- **Charting** (interactive, zoomable charts + per-stock stats)  
- **Trade** (buy/sell form + live estimate)  
- **Portfolio** (holdings, transactions, performance metrics)  
- **Leaderboard** (top investors ranked by portfolio value)  
- **News** (latest financial headlines, filterable + “load more”)  
- **Settings** (update email, username, password)  

## Contributors
- Grant DeBernardi: Grant-DeB
- Danny Toy: dannytoy
- Guilherme Avila Loges: guilhermeavlog
- Josh Lettau: jlettau12
- Luke Robinson: luker-robinson2
- Peter Benda: peterbenda

## Technology Stack Used for the Project
- **Frontend**  
  - HTML, CSS, Bootstrap 5
  - Handlebars.js for server-side templates  
  - Vanilla JS + Chart.js
- **Backend**  
  - **Web App:** Node.js (16+) + Express  
  - **API:** Python 3 + Flask (serving `/api/*` via `yfinance` + PostgreSQL)  
  - Authentication: `bcrypt`, `express-session`  
  - HTTP proxying: `http-proxy-middleware`  
- **Database**  
  - PostgreSQL (v14) with `pg-promise` (Node) and `psycopg2` (Flask)  
- **DevOps**  
  - Docker & Docker Compose  
  - Environment config
- **External APIs**  
  - Stock quotes via Yahoo Finance (`yfinance`)  
  - News via Finnhub

## Prerequisites to Run the Application
- Docker Desktop
- (Optional) Node.js ≥ 16 & Python 3 ≧ 3.8 if running services locally without Docker  
- A `.env` file in the project root with PostgreSQL and API keys

## Instructions on How to Run the Application Locally
- cd projectSoureCode
- docker-compose up --build

## Link to the Deployed Application
- [Live Application Here](https://stocksandbox.onrender.com/)
- [Launch API Web Service First Here](https://flask-api-nhm2.onrender.com)
