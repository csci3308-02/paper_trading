FROM python:3.11-slim

# working dir
WORKDIR /app

# copy files
COPY . .

# install yfinance and other dependencies
RUN pip install --no-cache-dir -r requirements.txt

# python server port
EXPOSE 8000

# run server
CMD ["python", "server.py"]
