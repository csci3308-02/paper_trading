CREATE TABLE users (
  user_id SERIAL PRIMARY KEY,
  username VARCHAR(50) PRIMARY KEY,
  password VARCHAR(60) NOT NULL,
  profits VARCHAR(10) NOT NULL,
  money_held VARCHAR(10) NOT NULL,
  money_in_stocks VARCHAR(10) NOT NULL
);