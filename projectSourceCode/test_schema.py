from graphviz import Digraph

# Initialize ER Diagram
er = Digraph('ER_Diagram', filename='paper_trading_er_diagram', format='png')
er.attr(rankdir='LR', size='12')

# Entities
entities = {
    "Users": ["user_id (PK)", "username", "email", "password_hash", "created_at"],
    "Portfolios": ["portfolio_id (PK)", "user_id (FK)", "name", "created_at"],
    "Stocks": ["stock_id (PK)", "symbol", "name", "exchange"],
    "StockPrices": ["price_id (PK)", "stock_id (FK)", "date", "open_price", "close_price", "high_price", "low_price", "volume"],
    "PortfolioHoldings": ["holding_id (PK)", "portfolio_id (FK)", "stock_id (FK)", "quantity", "avg_price"],
    "Transactions": ["transaction_id (PK)", "portfolio_id (FK)", "stock_id (FK)", "transaction_type", "quantity", "price", "executed_at"]
}

# Add entities to the ER diagram
for entity, attributes in entities.items():
    label = f"{entity} | {' | '.join(attributes)}"
    er.node(entity, label=label, shape='record')

# Relationships
er.edge("Users", "Portfolios", label="1 to Many")
er.edge("Portfolios", "PortfolioHoldings", label="1 to Many")
er.edge("Stocks", "PortfolioHoldings", label="Many to 1")
er.edge("Stocks", "StockPrices", label="1 to Many")
er.edge("Portfolios", "Transactions", label="1 to Many")
er.edge("Stocks", "Transactions", label="Many to 1")

# Render and save the ER diagram
er_path = "./er_diagram"
er.render(er_path, format="png", cleanup=True)
er_path
