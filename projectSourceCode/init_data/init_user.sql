-- Create the user if it doesn't exist
DO
$do$
BEGIN
   IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_roles
      WHERE  rolname = 'postgres_trading') THEN
      CREATE USER postgres_trading WITH PASSWORD 'pwd_trading';
   END IF;
END
$do$;

-- Grant privileges to the user
ALTER USER postgres_trading WITH CREATEDB;
ALTER USER postgres_trading WITH SUPERUSER;

-- Create the database if it doesn't exist
DO
$do$
BEGIN
   IF NOT EXISTS (
      SELECT FROM pg_database WHERE datname = 'trading_db') THEN
      CREATE DATABASE trading_db;
   END IF;
END
$do$;

-- Grant privileges on the database
GRANT ALL PRIVILEGES ON DATABASE trading_db TO postgres_trading; 