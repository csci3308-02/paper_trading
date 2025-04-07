FROM python:3.11-slim

# working dir
WORKDIR /app

# copy only necessary files first
COPY requirements.txt .

# install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# copy the rest of the application
COPY server.py .
COPY src/ ./src/
COPY views/ ./views/
COPY script.js .
COPY style.css .
COPY index.html .

# python server port
EXPOSE 8000

# run server
CMD ["python", "server.py"]
