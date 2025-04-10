FROM python:3.11-slim

# working directory
WORKDIR /app

# copy only necessary files first
COPY /stock_api/requirements.txt ./requirements.txt

# install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# copy the rest of the application
#COPY server.py .
COPY views/ ./views/
COPY ../public/script.js .
COPY ../public/style.css .
COPY index.js .

# python server port
EXPOSE 8000

# run server
CMD ["python3", "stock_api/server.py"]
