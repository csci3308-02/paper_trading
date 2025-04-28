-- This file ensures all required tables exist
-- It's safe to run multiple times as all statements use "IF NOT EXISTS"

-- Create pending_orders table if it doesn't exist
CREATE TABLE IF NOT EXISTS pending_orders (
    order_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    stock_id UUID NOT NULL REFERENCES stocks(stock_id) ON DELETE CASCADE,
    order_type VARCHAR(4) NOT NULL CHECK (order_type IN ('BUY', 'SELL')),
    quantity DECIMAL(15,4) NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'EXECUTED', 'FAILED', 'CANCELLED')),
    price_at_creation DECIMAL(15,2),
    executed_price DECIMAL(15,2),
    executed_at TIMESTAMP WITH TIME ZONE,
    notes TEXT
);

-- Create index for pending_orders if it doesn't exist
CREATE INDEX IF NOT EXISTS idx_pending_orders_user_id ON pending_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_orders_status ON pending_orders(status);

-- Add any future tables that need to be created here with IF NOT EXISTS 