FROM python:3.10-slim

WORKDIR /app

COPY /stock_api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python3", "projectSourceCode/stock_api/server.py"]
